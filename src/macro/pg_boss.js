const { unpack, normalizeQueues } = require("../utility")
const Hooks = require("../plan/hooks")

const DEFAULT_SCHEMA = "pgboss"
const DEFAULT_URL = "postgres://127.0.0.1:5432/postgres"
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const SAMPLE_QUERY_TIMEOUT_MS = 5000
const SAMPLE_POOL_OPTIONS = {
  max: 1,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 1000,
  query_timeout: SAMPLE_QUERY_TIMEOUT_MS,
  statement_timeout: SAMPLE_QUERY_TIMEOUT_MS,
}

const BLOCKED_ABSENT_TTL_MS = 60_000
const blockedColumnPresentCache = new Set()
const blockedColumnAbsentUntil = new Map()
const connectionIdMap = new WeakMap()
let connectionIdSeq = 0

function loadPg() {
  return require("pg")
}

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

async function jobQueueWorking(...args) {
  return withConnection(
    args,
    async (client, queues, schema) => {
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
    },
    { detectBlocked: false },
  )
}

function planOptions(_strategy, _options) {
  return {}
}

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

function supportsPlanStrategy(strategy) {
  const s = String(strategy)
  return s === "jql" || s === "jqs"
}

async function withConnection(args, fn, { detectBlocked = true } = {}) {
  const { queues: rawQueues, options } = unpack(args)
  const queues = normalizeQueues(rawQueues, { allowEmpty: true })
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
      connectionString,
    })
    ownedPool.on("error", () => {})
    queryable = ownedPool
    cacheKey = blockedCacheKey(schema, connectionString)
  }

  try {
    const flags = {
      hasBlockedColumn: detectBlocked
        ? await detectHasBlockedColumn(queryable, schema, cacheKey)
        : false,
    }
    return await fn(queryable, queues, schema, flags)
  } finally {
    if (ownedPool) {
      try {
        await ownedPool.end()
      } catch {}
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
  return `${schema}\0obj:${connectionIdentity(connection)}`
}

function connectionIdentity(connection) {
  if (!connection || typeof connection !== "object") return "unknown"
  const opts = connection.options || connection
  if (opts && typeof opts.connectionString === "string") {
    return opts.connectionString
  }
  if (opts && typeof opts.host === "string") {
    return `${opts.host}:${opts.port || 5432}/${opts.database || ""}`
  }
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
  const absentUntil = blockedColumnAbsentUntil.get(cacheKey)
  if (absentUntil != null && Date.now() < absentUntil) {
    return false
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
  if (has) {
    blockedColumnPresentCache.add(cacheKey)
    blockedColumnAbsentUntil.delete(cacheKey)
  } else {
    blockedColumnAbsentUntil.set(cacheKey, Date.now() + BLOCKED_ABSENT_TTL_MS)
  }
  return has
}

function _resetBlockedColumnCacheForTests() {
  blockedColumnPresentCache.clear()
  blockedColumnAbsentUntil.clear()
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
