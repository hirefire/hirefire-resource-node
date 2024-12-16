const IORedis = require("ioredis")
const { unpack } = require("../utility")
const { jobQueueLatencyUnsupported } = require("../errors")
const fs = require("fs")
const path = require("path")
const jobQueueSizeLuaScript = fs.readFileSync(
  path.join(__dirname, "bullmq", "job_queue_size.lua"),
  "utf8",
)

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
 * Calculates the total job queue size across (specified) queues.
 * Handles both explicitly specified queues and auto-discovery of queues.
 *
 * @async
 * @param {...string} queues - Names of the queues for size measurement.
 * @param {object} [options] - Optional options object. The options object can include:
 *                             - connection: Passed to IORedis, compatible with its connection options.
 *                               If not provided, uses environment variables or defaults to localhost.
 *                             - prefix: The BullMQ prefix to use (defaults to "bull")
 * @returns {Promise<number>} Cumulative job queue size across the (specified) queues.
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
 * @example
 * // Calculate size with custom prefix
 * await jobQueueSize("default", { prefix: "custom" })
 */
async function jobQueueSize(...args) {
  let { queues, options } = unpack(args)

  if (options.prefix === "") {
    throw new Error("Prefix cannot be empty")
  }

  const redis = new IORedis(
    options.connection ||
      process.env.REDIS_TLS_URL ||
      process.env.REDIS_URL ||
      process.env.REDISTOGO_URL ||
      process.env.REDISCLOUD_URL ||
      process.env.OPENREDIS_URL ||
      "redis://localhost:6379/0",
  )

  try {
    return await redis.eval(
      jobQueueSizeLuaScript,
      0,
      Date.now() * 0x1000,
      options.prefix || "bull",
      ...queues,
    )
  } finally {
    await redis.quit()
  }
}

module.exports = { jobQueueLatency, jobQueueSize }
