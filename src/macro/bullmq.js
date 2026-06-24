const IORedis = require("ioredis")
const { unpack } = require("../utility")
const { jobQueueLatencyUnsupported } = require("../errors")

/**
 * Job queue latency is not supported for BullMQ. Calling this always throws.
 *
 * @async
 * @param {...any} args - Ignored.
 * @returns {Promise<never>} Never resolves: the call always throws.
 * @throws {JobQueueLatencyUnsupportedError} Always, since BullMQ does not support latency measurement.
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
 * @overload
 * @param {...string} queues - Queue names. Omit to measure across all queues.
 * @returns {Promise<number>} Cumulative job queue size across the specified queues.
 */
/**
 * @overload
 * @param {...(string | BullMQOptions)} queuesAndOptions - Queue names, optionally followed by a
 *   {@link BullMQOptions} object.
 * @returns {Promise<number>} Cumulative job queue size across the specified queues.
 */
/**
 * Calculates the total job queue size across the specified queues. If no queues are specified, it
 * measures size across all queues.
 *
 * @async
 * @param {...any} args - Queue names, optionally followed by a {@link BullMQOptions} object.
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
 * @example
 * // Calculate size using the options.connection property
 * await jobQueueSize("default", { connection: "redis://localhost:6379/0" })
 * @example
 * // Calculate size using the options.connectionOptions property
 * await jobQueueSize("default", { connectionOptions: { tls: { rejectUnauthorized: false } } })
 */
async function jobQueueSize(...args) {
  let { queues, options } = unpack(args)

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

  if (queues.length === 0) {
    const pipeline = redis.pipeline()
    pipeline.keys("bull:*:wait")
    pipeline.keys("bull:*:active")
    pipeline.keys("bull:*:delayed")

    const results = await pipeline.exec()
    const keys = results.flatMap(([err, result]) => result || [])
    const uniqueQueueNames = new Set()

    keys.forEach((key) => {
      const match = key.match(/^bull:(.*):(wait|active|delayed)$/)
      if (match) {
        uniqueQueueNames.add(match[1])
      }
    })

    queues = Array.from(uniqueQueueNames)
  }

  let totalCount = 0

  try {
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
      const waitCount = results[i + 1][1] || 0
      const activeCount = results[i + 2][1] || 0
      const delayedCount = results[i + 3][1] || 0

      totalCount += waitCount + activeCount + delayedCount

      if (lastWaitJob && lastWaitJob.startsWith("0:")) {
        totalCount -= 1
      }
    }
  } finally {
    await redis.quit()
  }

  return totalCount
}

module.exports = { jobQueueLatency, jobQueueSize }
