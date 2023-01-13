const IORedis = require("ioredis")
const { unpack } = require("../utility")
const { jobQueueLatencyUnsupported } = require("../errors")

/**
 * Measures job queue latency. Currently, this functionality is not supported for BullMQ.
 *
 * @async
 * @param {...any} args - Any number of arguments (ignored in function).
 * @throws {JobQueueLatencyUnsupportedError} - Indicates that the module does not support job queue latency measurements.
 * @returns {Promise<void>} - The function is asynchronous, but its return value is not used.
 */
async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("BullMQ")
}

/**
 * Calculates the total job queue size across specified queues.
 *
 * @async
 * @param {...string} queues - Names of the queues for size measurement.
 * @param {object} [options] - Optional options object. The options object can include a
 *                             `connection` property, which is passed to IORedis and is compatible
 *                             with its connection options. If no connection is provided, the
 *                             function will use the value of the `REDIS_TLS_URL`, `REDIS_URL`,
 *                             `REDISTOGO_URL`, `REDISCLOUD_URL`, `OPENREDIS_URL` environment
 *                             variables, in the order specified. If none of these environment
 *                             variables are set, it defaults to `redis://localhost:6379/0`.
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
 * // Calculate Size using the options.connection property
 * await jobQueueSize("default", { connection: "redis://localhost:6379/0" })
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
