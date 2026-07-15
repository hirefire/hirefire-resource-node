const IORedis = require("ioredis")
const { unpack, normalizeQueues } = require("../utility")
const {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../errors")

/**
 * Job queue latency is not supported for BullMQ. The returned promise always rejects with
 * {@link JobQueueLatencyUnsupportedError} (it does not throw synchronously).
 *
 * @async
 * @param {...any} args - Ignored.
 * @returns {Promise<never>} Always rejects with {@link JobQueueLatencyUnsupportedError} and never fulfills.
 * @throws {JobQueueLatencyUnsupportedError} Observed when the rejection is awaited or handled with
 *   `.catch` (not thrown synchronously).
 */
async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("BullMQ")
}

/**
 * @typedef {object} BullMQOptions
 * @property {string | object} [connection] - IORedis connection: a URL string or an IORedis
 *   options object. When omitted, the `REDIS_TLS_URL`, `REDIS_URL`, `REDISTOGO_URL`,
 *   `REDISCLOUD_URL`, `OPENREDIS_URL` environment variables are tried in order, then
 *   `redis://localhost:6379/0`.
 * @property {object} [connectionOptions] - Passed as the second argument to the IORedis
 *   constructor, for further customization (e.g. TLS options, retry strategies).
 */

/**
 * Calculates the total job queue size across the specified queues. If no queues are specified, it
 * measures size across all queues.
 *
 * @overload
 * @param {...string} queues - Queue names. Omit to measure across all queues.
 * @returns {Promise<number>} Cumulative job queue size across the specified queues.
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
 * @param {...(string | BullMQOptions)} queuesAndOptions - Queue names, optionally followed by a
 *   {@link BullMQOptions} object.
 * @returns {Promise<number>} Cumulative job queue size across the specified queues.
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
async function jobQueueSize(...args) {
  let { queues, options } = unpack(args)
  queues = normalizeQueues(queues)

  const redis = new IORedis(
    options.connection ||
      process.env.REDIS_TLS_URL ||
      process.env.REDIS_URL ||
      process.env.REDISTOGO_URL ||
      process.env.REDISCLOUD_URL ||
      process.env.OPENREDIS_URL ||
      "redis://localhost:6379/0",
    options.connectionOptions,
  )

  try {
    if (queues.length === 0) {
      queues = await enumerateQueues(redis)
    }

    let totalCount = 0
    const pipeline = redis.pipeline()
    const now = Date.now() * 0x1000 // Match BullMQ's delayed job timestamp score encoding.

    for (const queue of queues) {
      pipeline.lindex(`bull:${queue}:wait`, -1)
      pipeline.llen(`bull:${queue}:wait`)
      pipeline.llen(`bull:${queue}:active`)
      pipeline.zcount(`bull:${queue}:delayed`, "-inf", now)
    }

    const results = await pipeline.exec()

    for (let i = 0; i < results.length; i += 4) {
      const lastWaitJob = results[i][1]
      const waitCount = Number(results[i + 1][1]) || 0
      const activeCount = Number(results[i + 2][1]) || 0
      const delayedCount = Number(results[i + 3][1]) || 0

      totalCount += waitCount + activeCount + delayedCount

      if (lastWaitJob && lastWaitJob.startsWith("0:")) {
        totalCount -= 1
      }
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
      const match = key.match(/^bull:(.*):(wait|active|delayed)$/)
      if (match) {
        uniqueQueueNames.add(match[1])
      }
    }
  } while (cursor !== "0")

  return Array.from(uniqueQueueNames)
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  JobQueueLatencyUnsupportedError,
}
