const { unpack, normalizeQueues } = require("../utility")
const Hooks = require("../plan/hooks")

const DEFAULT_SCHEMA = "pgboss"
const DEFAULT_URL = "postgres://127.0.0.1:5432/postgres"
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
// Sample query budget (ms). Also applied as statement_timeout on owned pools.
const SAMPLE_QUERY_TIMEOUT_MS = 5000

// Defaults for short-lived sample-only pools.
const SAMPLE_POOL_OPTIONS = {
  max: 1,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 1000,
  // node-pg aborts queries that exceed this (client-side).
  query_timeout: SAMPLE_QUERY_TIMEOUT_MS,
  // Server-side cancel if the statement still runs past the budget.
  statement_timeout: SAMPLE_QUERY_TIMEOUT_MS,
}

// Process-local cache: cacheKey → true when blocked column is known present.
// Absent/false is not cached permanently so migrate-add-blocked and missing-table
// recover on the next sample.
const blockedColumnPresentCache = new Set()
// Stable ids for borrowed pools/clients without mutating them.
const connectionIdMap = new WeakMap()
let connectionIdSeq = 0

// Lazy: core test cell and plan path load this module without installing pg.
function loadPg() {
  return require("pg")
}

/**
 * @typedef {object} PgBossOptions
 * @property {string | object} [connection] - Postgres URL string, or a `pg.Pool` /
 *   client-like object with `.query`. When omitted, `HIREFIRE_PG_BOSS_URL`, then
 *   `DATABASE_URL`, then `postgres://127.0.0.1:5432/postgres`. Plan path may inject
 *   `HIREFIRE_PG_BOSS_URL` via {@link planConnectionOptions}.
 * @property {object} [connectionOptions] - Extra options for `new pg.Pool({
 *   connectionString, ...connectionOptions })` when the macro opens a pool.
 * @property {string} [schema] - pg-boss schema name. Default `pgboss`, or
 *   `HIREFIRE_PG_BOSS_SCHEMA` when set. Folded to lowercase (unquoted identifier).
 * @property {object} [pool] - Alias for providing a borrowed `pg.Pool` (do not end).
 */

/**
 * Calculates waiting job queue size (JQS) across the specified queues. Counts rows
 * on the parent `${schema}.job` table with `state < 'active'`, `start_after <= now()`,
 * and `NOT blocked` when that column exists (schema ≥ 31 / pg-boss ≥ 12.19). Active,
 * future deferred, dependency-blocked, and terminal states are excluded. Empty queue
 * list measures all queues.
 *
 * @overload
 * @param {...string} queues - Queue names. Omit to measure across all queues.
 * @returns {Promise<number>} Cumulative waiting job count across the specified queues.
 * @example
 * // Calculate size across all queues
 * await jobQueueSize()
 * @example
 * // Calculate size for the "email" queue
 * await jobQueueSize("email")
 * @example
 * // Calculate size across "email" and "sms" queues
 * await jobQueueSize("email", "sms")
 */
/**
 * @overload
 * @param {...(string | PgBossOptions)} queuesAndOptions - Queue names, optionally followed by a
 *   {@link PgBossOptions} object.
 * @returns {Promise<number>} Cumulative waiting job count across the specified queues.
 * @example
 * // Calculate size using the options.connection property
 * await jobQueueSize("email", { connection: process.env.DATABASE_URL })
 * @example
 * // Calculate size with a custom schema
 * await jobQueueSize("email", { schema: "pgboss" })
 */
/**
 * @async
 * @param {...any} args
 * @returns {Promise<number>}
 */
async function jobQueueSize(...args) {
  return withConnection(args, async (client, queues, schema, flags) => {
    const sql = `
      SELECT COUNT(*)::bigint AS job_queue_size
      FROM ${schema}.job
      WHERE ${buildWaitingWhere(queues, flags)}
    `
    const values = queues.length ? [queues] : []
    const { rows } = await client.query(sql, values)
    return Number(rows[0].job_queue_size) || 0
  })
}

/**
 * Calculates waiting job queue latency (JQL) across the specified queues. Age is
 * `EXTRACT(EPOCH FROM (now() - start_after))` for the oldest due waiting job (same
 * waiting predicate as {@link jobQueueSize}). Empty waiting set returns `0`.
 *
 * @overload
 * @param {...string} queues - Queue names. Omit to measure across all queues.
 * @returns {Promise<number>} Maximum waiting latency in seconds across the specified queues.
 * @example
 * // Calculate latency across all queues
 * await jobQueueLatency()
 * @example
 * // Calculate latency for the "email" queue
 * await jobQueueLatency("email")
 */
/**
 * @overload
 * @param {...(string | PgBossOptions)} queuesAndOptions - Queue names, optionally followed by a
 *   {@link PgBossOptions} object.
 * @returns {Promise<number>} Maximum waiting latency in seconds across the specified queues.
 * @example
 * // Calculate latency using the options.connection property
 * await jobQueueLatency("email", { connection: process.env.DATABASE_URL })
 */
/**
 * @async
 * @param {...any} args
 * @returns {Promise<number>}
 */
async function jobQueueLatency(...args) {
  return withConnection(args, async (client, queues, schema, flags) => {
    const sql = `
      SELECT EXTRACT(EPOCH FROM (now() - start_after))::float8 AS latency
      FROM ${schema}.job
      WHERE ${buildWaitingWhere(queues, flags)}
      ORDER BY start_after ASC
      LIMIT 1
    `
    const values = queues.length ? [queues] : []
    const { rows } = await client.query(sql, values)
    if (!rows[0] || rows[0].latency == null) return 0
    const latency = Number(rows[0].latency)
    if (!Number.isFinite(latency)) return 0
    return Math.max(0, latency)
  })
}

/**
 * Counts in-flight (working) jobs: rows with `state = 'active'`. Empty queue
 * list measures all names. Never folded into JQL/JQS. Plan records under `wrk`.
 *
 * @async
 * @param {...any} args - Queue names, optionally followed by a {@link PgBossOptions} object.
 * @returns {Promise<number>} Cumulative active job count.
 * @example
 * await jobQueueWorking()
 * @example
 * await jobQueueWorking("email", "sms")
 */
async function jobQueueWorking(...args) {
  return withConnection(args, async (client, queues, schema) => {
    const parts = [`state = 'active'`]
    if (queues.length) parts.push(`name = ANY($1::text[])`)
    const sql = `
      SELECT COUNT(*)::bigint AS job_queue_working
      FROM ${schema}.job
      WHERE ${parts.join("\n  AND ")}
    `
    const values = queues.length ? [queues] : []
    const { rows } = await client.query(sql, values)
    return Number(rows[0].job_queue_working) || 0
  })
}

/**
 * @param {string} _strategy
 * @param {*} _options
 * @returns {object}
 */
function planOptions(_strategy, _options) {
  return {}
}

/**
 * @returns {object}
 */
function planConnectionOptions() {
  const out = {}
  const urlRaw = process.env.HIREFIRE_PG_BOSS_URL
  if (urlRaw != null) {
    const url = String(urlRaw).trim()
    if (url) out.connection = url
  }
  const schemaRaw = process.env.HIREFIRE_PG_BOSS_SCHEMA
  if (schemaRaw != null) {
    const schema = String(schemaRaw).trim()
    if (schema) out.schema = schema
  }
  return out
}

/**
 * pg-boss plans support size and latency.
 *
 * @param {string|symbol} strategy
 * @returns {boolean}
 */
function supportsPlanStrategy(strategy) {
  const s = String(strategy)
  return s === "jql" || s === "jqs"
}

async function withConnection(args, fn) {
  const { queues: rawQueues, options } = unpack(args)
  const queues = normalizeQueues(rawQueues)
  // Fold to lowercase to match unquoted Postgres identifier semantics so
  // FROM schema.job and information_schema.table_schema agree.
  const schema = resolveSchema(options).toLowerCase()
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid pg-boss schema name: ${schema}`)
  }

  const connection = resolveConnection(options)
  let queryable
  let ownedPool = null
  let cacheKey

  if (isQueryable(connection)) {
    queryable = connection
    cacheKey = blockedCacheKey(schema, connection)
  } else if (isQueryable(options.pool)) {
    queryable = options.pool
    cacheKey = blockedCacheKey(schema, options.pool)
  } else if (connection != null && typeof connection === "object") {
    throw new TypeError(
      "pg-boss connection must be a URL string or a client/Pool with .query",
    )
  } else {
    const { Pool } = loadPg()
    const userOpts = options.connectionOptions || {}
    const connectionString = String(connection)
    ownedPool = new Pool({
      ...SAMPLE_POOL_OPTIONS,
      ...userOpts,
      // Resolved URL always wins over a connectionString in connectionOptions.
      connectionString,
    })
    // Unhandled pool "error" events terminate the Node process.
    ownedPool.on("error", () => {})
    queryable = ownedPool
    cacheKey = blockedCacheKey(schema, connectionString)
  }

  try {
    const flags = {
      hasBlockedColumn: await detectHasBlockedColumn(
        queryable,
        schema,
        cacheKey,
      ),
    }
    return await fn(queryable, queues, schema, flags)
  } finally {
    if (ownedPool) {
      try {
        await ownedPool.end()
      } catch {
        // Never let teardown override the sample result or original error.
      }
    }
  }
}

function resolveSchema(options) {
  if (options.schema != null) {
    const s = String(options.schema).trim()
    if (s) return s
  }
  const env = process.env.HIREFIRE_PG_BOSS_SCHEMA
  if (env != null) {
    const s = String(env).trim()
    if (s) return s
  }
  return DEFAULT_SCHEMA
}

function resolveConnection(options) {
  if (options.connection != null && options.connection !== "") {
    return options.connection
  }
  if (isQueryable(options.pool)) {
    return options.pool
  }
  const hirefireUrl = process.env.HIREFIRE_PG_BOSS_URL
  if (hirefireUrl != null && String(hirefireUrl).trim()) {
    return String(hirefireUrl).trim()
  }
  const databaseUrl = process.env.DATABASE_URL
  if (databaseUrl != null && String(databaseUrl).trim()) {
    return String(databaseUrl).trim()
  }
  return DEFAULT_URL
}

function isQueryable(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.query === "function"
  )
}

function buildWaitingWhere(queues, flags) {
  const parts = [`state < 'active'`, `start_after <= now()`]
  if (flags.hasBlockedColumn) parts.push(`NOT blocked`)
  if (queues.length) parts.push(`name = ANY($1::text[])`)
  return parts.join("\n  AND ")
}

function blockedCacheKey(schema, connection) {
  if (typeof connection === "string") {
    return `${schema}\0${connection}`
  }
  // Borrowed client/Pool: identity by object reference (stable per process).
  return `${schema}\0obj:${connectionIdentity(connection)}`
}

function connectionIdentity(connection) {
  if (!connection || typeof connection !== "object") return "unknown"
  // Prefer a stable URL when the pool exposes one (node-pg Pool options).
  const opts = connection.options || connection
  if (opts && typeof opts.connectionString === "string") {
    return opts.connectionString
  }
  if (opts && typeof opts.host === "string") {
    return `${opts.host}:${opts.port || 5432}/${opts.database || ""}`
  }
  // Per-object id via WeakMap (no property write on the caller's pool).
  let id = connectionIdMap.get(connection)
  if (!id) {
    connectionIdSeq += 1
    id = `p${connectionIdSeq}`
    connectionIdMap.set(connection, id)
  }
  return id
}

async function detectHasBlockedColumn(client, schema, cacheKey) {
  if (blockedColumnPresentCache.has(cacheKey)) {
    return true
  }
  const { rows } = await client.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'job'
        AND column_name = 'blocked'
      LIMIT 1`,
    [schema],
  )
  const has = rows.length > 0
  // Only cache presence. Absence may become true after migrate, or the job table
  // may appear later. Re-probe each sample until true.
  if (has) blockedColumnPresentCache.add(cacheKey)
  return has
}

/** @internal Test-only: clear positive blocked-column cache between unit cases. */
function _resetBlockedColumnCacheForTests() {
  blockedColumnPresentCache.clear()
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  planOptions,
  planConnectionOptions,
  supportsPlanStrategy,
  beforeSampleJobQueues: Hooks.beforeSampleJobQueues,
  afterSampleJobQueues: Hooks.afterSampleJobQueues,
  reinitAfterFork: Hooks.reinitAfterFork,
  _resetBlockedColumnCacheForTests,
}
