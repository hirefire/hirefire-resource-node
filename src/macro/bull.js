const { unpack, normalizeQueues } = require("../utility")
const {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../errors")
const Hooks = require("../plan/hooks")

function loadIORedis() {
  return require("ioredis")
}

/**
 * Job queue latency is not supported for classic Bull. The returned promise always rejects with
 * {@link JobQueueLatencyUnsupportedError} (it does not throw synchronously).
 *
 * @async
 * @param {...any} args - Ignored.
 * @returns {Promise<never>} Always rejects with {@link JobQueueLatencyUnsupportedError} and never fulfills.
 * @throws {JobQueueLatencyUnsupportedError} Observed when the rejection is awaited or handled with
 *   `.catch` (not thrown synchronously).
 */
async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("Bull")
}

/**
 * @typedef {object} BullOptions
 * @property {string | object} [connection] - IORedis connection: a URL string or an IORedis
 *   options object. When omitted, the `REDIS_TLS_URL`, `REDIS_URL`, `REDISTOGO_URL`,
 *   `REDISCLOUD_URL`, `OPENREDIS_URL` environment variables are tried in order, then
 *   `redis://localhost:6379/0`. Plan path may inject `HIREFIRE_BULL_URL` via
 *   {@link planConnectionOptions}.
 * @property {object} [connectionOptions] - Passed as the second argument to the IORedis
 *   constructor, for further customization (e.g. TLS options, retry strategies).
 */

/**
 * Calculates waiting job queue size (JQS) across the specified queues. Counts live wait and
 * paused lists plus due delayed jobs (score ≤ now). Priority jobs are already members of
 * wait/paused (do not ZCARD the priority index). Active (working) jobs are excluded. Classic
 * Bull has no `0:` wait markers (unlike BullMQ). If no queues are specified, measures across
 * all discovered queues.
 *
 * @overload
 * @param {...string} queues - Queue names. Omit to measure across all queues.
 * @returns {Promise<number>} Cumulative waiting job count across the specified queues.
 * @example
 * // Calculate size across all queues
 * await jobQueueSize()
 * @example
 * // Calculate size for the "default" queue
 * await jobQueueSize("default")
 * @example
 * // Calculate size across "default" and "mailer" queues
 * await jobQueueSize("default", "mailer")
 */
/**
 * @overload
 * @param {...(string | BullOptions)} queuesAndOptions - Queue names, optionally followed by a
 *   {@link BullOptions} object.
 * @returns {Promise<number>} Cumulative waiting job count across the specified queues.
 * @example
 * // Calculate size using the options.connection property
 * await jobQueueSize("default", { connection: "redis://localhost:6379/0" })
 * @example
 * // Calculate size using the options.connectionOptions property
 * await jobQueueSize("default", { connectionOptions: { tls: { rejectUnauthorized: false } } })
 */
/**
 * @async
 * @param {...any} args
 * @returns {Promise<number>}
 */
/**
 * Defaults for short-lived sample connections (audit H1).
 * Keep enableOfflineQueue at ioredis default (true) so commands issued before
 * the socket is ready still run; bound wait with connect/command timeouts and
 * cap retries so an unreachable Redis cannot hang the plan path indefinitely.
 */
const SAMPLE_REDIS_OPTIONS = {
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  commandTimeout: 5000,
  retryStrategy(times) {
    if (times > 2) return null
    return Math.min(times * 50, 200)
  },
}

async function jobQueueSize(...args) {
  const IORedis = loadIORedis()
  let { queues, options } = unpack(args)
  queues = normalizeQueues(queues)

  const connection =
    options.connection ||
    process.env.REDIS_TLS_URL ||
    process.env.REDIS_URL ||
    process.env.REDISTOGO_URL ||
    process.env.REDISCLOUD_URL ||
    process.env.OPENREDIS_URL ||
    "redis://localhost:6379/0"

  const userConnectionOptions = options.connectionOptions || {}
  const redis =
    typeof connection === "object" && connection !== null
      ? new IORedis({
          ...SAMPLE_REDIS_OPTIONS,
          ...connection,
          ...userConnectionOptions,
        })
      : new IORedis(connection, {
          ...SAMPLE_REDIS_OPTIONS,
          ...userConnectionOptions,
        })

  redis.on("error", () => {})

  try {
    if (queues.length === 0) {
      queues = await enumerateQueues(redis)
    }

    let totalCount = 0
    const pipeline = redis.pipeline()
    const delayedUpper = (Date.now() + 1) * 0x1000 - 1
    const cmdsPerQueue = 3

    for (const queue of queues) {
      pipeline.llen(`bull:${queue}:wait`)
      pipeline.llen(`bull:${queue}:paused`)
      pipeline.zcount(`bull:${queue}:delayed`, "-inf", delayedUpper)
    }

    const results = await pipeline.exec()
    if (!results) return 0

    for (let i = 0; i < results.length; i += cmdsPerQueue) {
      const waitCount = toCount(pipelineValue(results[i]))
      const pausedCount = toCount(pipelineValue(results[i + 1]))
      const delayedCount = toCount(pipelineValue(results[i + 2]))

      totalCount += waitCount + pausedCount + delayedCount
    }

    return totalCount
  } finally {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }
}

/**
 * Counts in-flight (working) jobs: LLEN of each queue's `active` list. Empty
 * queue list measures every discovered queue. Never folded into JQS. Plan
 * records under nested strategy `wrk`.
 *
 * @async
 * @param {...any} args - Queue names, optionally followed by a {@link BullOptions} object.
 * @returns {Promise<number>} Cumulative active job count.
 * @example
 * await jobQueueWorking()
 * @example
 * await jobQueueWorking("default", "mailer")
 */
async function jobQueueWorking(...args) {
  const IORedis = loadIORedis()
  let { queues, options } = unpack(args)
  queues = normalizeQueues(queues)

  const connection =
    options.connection ||
    process.env.REDIS_TLS_URL ||
    process.env.REDIS_URL ||
    process.env.REDISTOGO_URL ||
    process.env.REDISCLOUD_URL ||
    process.env.OPENREDIS_URL ||
    "redis://localhost:6379/0"

  const userConnectionOptions = options.connectionOptions || {}
  const redis =
    typeof connection === "object" && connection !== null
      ? new IORedis({
          ...SAMPLE_REDIS_OPTIONS,
          ...connection,
          ...userConnectionOptions,
        })
      : new IORedis(connection, {
          ...SAMPLE_REDIS_OPTIONS,
          ...userConnectionOptions,
        })

  redis.on("error", () => {})

  try {
    if (queues.length === 0) {
      queues = await enumerateQueues(redis)
    }

    let totalCount = 0
    const pipeline = redis.pipeline()
    for (const queue of queues) {
      pipeline.llen(`bull:${queue}:active`)
    }

    const results = await pipeline.exec()
    if (!results) return 0

    for (const tuple of results) {
      totalCount += toCount(pipelineValue(tuple))
    }

    return totalCount
  } finally {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }
}

async function enumerateQueues(redis) {
  const uniqueQueueNames = new Set()
  let cursor = "0"

  do {
    const [nextCursor, keys] = await redis.scan(
      cursor,
      "MATCH",
      "bull:*",
      "COUNT",
      100,
    )
    cursor = nextCursor

    for (const key of keys) {
      const match = key.match(
        /^bull:(.*):(wait|paused|active|delayed|priority)$/,
      )
      if (match) {
        uniqueQueueNames.add(match[1])
      }
    }
  } while (cursor !== "0")

  return Array.from(uniqueQueueNames)
}

function pipelineValue(tuple) {
  if (!tuple) return null
  const [err, value] = tuple
  if (err) return null
  return value
}

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
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
  const raw = process.env.HIREFIRE_BULL_URL
  if (raw == null) return {}
  const url = String(raw).trim()
  if (!url) return {}
  return { connection: url }
}

/**
 * Classic Bull plans support size only (not latency).
 *
 * @param {string|symbol} strategy
 * @returns {boolean}
 */
function supportsPlanStrategy(strategy) {
  return String(strategy) === "jqs"
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  JobQueueLatencyUnsupportedError,
  planOptions,
  planConnectionOptions,
  supportsPlanStrategy,
  beforeSampleJobQueues: Hooks.beforeSampleJobQueues,
  afterSampleJobQueues: Hooks.afterSampleJobQueues,
  reinitAfterFork: Hooks.reinitAfterFork,
}
