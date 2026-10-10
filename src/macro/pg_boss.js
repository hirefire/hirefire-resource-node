const { load } = require("../optional")
const { unpack, presence, normalizeQueues } = require("../utility")

const DEFAULT_SCHEMA = "pgboss"
const DEFAULT_URL = "postgres://postgres:postgres@127.0.0.1:5432/postgres"
const SCHEMA_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const URL_SSL_RE = /[?&]ssl[a-z]*=/i
const SAMPLE_POOL_OPTIONS = {
  max: 1,
  connectionTimeoutMillis: 5000,
  idleTimeoutMillis: 1000,
  query_timeout: 5000,
}

const COLUMNS = ["blocked", "expire_in", "expire_seconds", "heartbeat_seconds"]
const COLUMNS_TTL = 60

const columnsCache = new Map()
const connectionIdMap = new WeakMap()
let connectionIdSeq = 0

async function jobQueueSize(...args) {
  const { skipWorking } = unpack(args).options
  return withConnection(args, async (client, queues, schema, columns) => {
    const { waiting, orphaned } = conditions(columns)
    const counted = either(waiting, skipWorking ? orphaned : `state = 'active'`)
    const sql = `
      SELECT COUNT(*)::bigint AS job_queue_size
      FROM ${schema}.job
      WHERE ${buildWhere(counted, queues)}
    `
    const values = queues.length ? [queues] : []
    const { rows } = await client.query(sql, values)
    return Number(rows[0].job_queue_size) || 0
  })
}

async function jobQueueLatency(...args) {
  return withConnection(args, async (client, queues, schema, columns) => {
    const { waiting, orphaned } = conditions(columns)
    const sql = `
      SELECT EXTRACT(EPOCH FROM (now() - start_after))::float8 AS latency
      FROM ${schema}.job
      WHERE ${buildWhere(either(waiting, orphaned), queues)}
      ORDER BY start_after ASC
      LIMIT 1
    `
    const values = queues.length ? [queues] : []
    const { rows } = await client.query(sql, values)
    return Number(rows[0]?.latency ?? 0)
  })
}

async function jobQueueWorking(...args) {
  return withConnection(args, async (client, queues, schema, columns) => {
    const sql = `
      SELECT COUNT(*)::bigint AS job_queue_working
      FROM ${schema}.job
      WHERE ${buildWhere(conditions(columns).running, queues)}
    `
    const values = queues.length ? [queues] : []
    const { rows } = await client.query(sql, values)
    return Number(rows[0].job_queue_working) || 0
  })
}

async function withConnection(args, fn) {
  const { queues: rawQueues, options } = unpack(args)
  const queues = normalizeQueues(rawQueues, { allowEmpty: true })
  const schema = resolveSchema(options).toLowerCase()
  if (!SCHEMA_RE.test(schema)) {
    throw new Error(`Invalid pg-boss schema name: ${schema}`)
  }

  const borrowed = [options.connection, options.pool].find(isQueryable)
  if (borrowed) {
    const columns = await jobColumns(
      borrowed,
      schema,
      connectionIdentity(borrowed),
    )
    return fn(borrowed, queues, schema, columns)
  }

  const connection = resolveConnection(options)
  if (typeof connection === "object") {
    throw new TypeError(
      "pg-boss connection must be a URL string or a client/Pool with .query",
    )
  }

  const { Pool } = load("pg")
  const userOpts = options.connectionOptions || {}
  const connectionString = String(connection)
  const pool = new Pool({
    ...SAMPLE_POOL_OPTIONS,
    ...herokuSslDefault(connectionString),
    ...userOpts,
    connectionString,
  })
  pool.on("error", () => {})

  try {
    const columns = await jobColumns(pool, schema, connectionString)
    return await fn(pool, queues, schema, columns)
  } finally {
    try {
      await pool.end()
    } catch {}
  }
}

function resolveSchema(options) {
  return (
    presence(options.schema) ??
    presence(process.env.HIREFIRE_PG_BOSS_SCHEMA) ??
    DEFAULT_SCHEMA
  )
}

function resolveConnection(options) {
  if (options.connection != null && options.connection !== "") {
    return options.connection
  }
  return (
    presence(process.env.HIREFIRE_PG_BOSS_URL) ??
    presence(process.env.DATABASE_URL) ??
    DEFAULT_URL
  )
}

function herokuSslDefault(connectionString) {
  const applies =
    process.env.DYNO &&
    !process.env.PGSSLMODE &&
    !URL_SSL_RE.test(connectionString)
  return applies ? { ssl: { rejectUnauthorized: false } } : {}
}

function isQueryable(value) {
  return (
    value != null &&
    typeof value === "object" &&
    typeof value.query === "function"
  )
}

function conditions(columns) {
  const waiting = [`state < 'active'`, `start_after <= now()`]
  if (columns.has("blocked")) waiting.push(`NOT blocked`)

  const expired = []
  if (columns.has("expire_seconds")) {
    expired.push(`started_on + expire_seconds * interval '1 second' < now()`)
  } else if (columns.has("expire_in")) {
    expired.push(`started_on + expire_in < now()`)
  }
  if (columns.has("heartbeat_seconds")) {
    expired.push(
      `heartbeat_on + heartbeat_seconds * interval '1 second' < now()`,
    )
  }
  const dead = expired.join(" OR ")

  return {
    waiting: waiting.join(" AND "),
    orphaned: dead && `(state = 'active' AND (${dead}))`,
    running: dead
      ? `state = 'active' AND (${dead}) IS NOT TRUE`
      : `state = 'active'`,
  }
}

function either(condition, other) {
  return other ? `(${condition}) OR ${other}` : condition
}

function buildWhere(condition, queues) {
  if (!queues.length) return condition
  return `(${condition}) AND name = ANY($1::text[])`
}

function connectionIdentity(connection) {
  const opts = connection.options || connection
  if (typeof opts.connectionString === "string") {
    return opts.connectionString
  }
  if (typeof opts.host === "string") {
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

async function jobColumns(client, schema, connection) {
  const key = `${schema}\0${connection}`
  const cached = columnsCache.get(key)
  if (cached && Date.now() < cached.until) return cached.columns

  const { rows } = await client.query(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'job'
        AND column_name = ANY($2::text[])`,
    [schema, COLUMNS],
  )
  const columns = new Set(rows.map((row) => row.column_name))
  columnsCache.set(key, { columns, until: Date.now() + COLUMNS_TTL * 1000 })
  return columns
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
}
