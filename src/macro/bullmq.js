const IORedis = require('ioredis')
const { MissingQueueError } = require('../errors')

/**
 * Calculates the total job queue size across the specified queues.
 *
 * @param {...string | object} args - Queue names followed by an optional options object.  The
 *                                    options object can include a 'connection' property, which is
 *                                    passed to IORedis and is compatible with its connection
 *                                    options.  Defaults to REDIS_TLS_URL, REDIS_URL, or localhost
 *                                    if not provided.
 * @returns {Promise<number>} Cumulative job queue size across the specified queues.
 * @throws {MissingQueueError} If no queues are provided to the function.
 * @example
 * // Job Queue Size for the default queue
 * await jobQueueSize('default')
 * @example
 * // Job Queue Size across the default and mailer queues
 * await jobQueueSize('default', 'mailer')
 * @example
 * // Job Queue Size using the options.connection property
 * await jobQueueSize('default', { connection: 'redis://localhost:6379/0' })
 */
async function jobQueueSize (...args) {
  const { queues, options } = unpack(args)

  if (queues.length === 0) {
    throw new MissingQueueError()
  }

  const redis = new IORedis(
    options.connection ||
      process.env.REDIS_TLS_URL ||
      process.env.REDIS_URL ||
      'redis://localhost:6379'
  )

  let totalCount = 0

  try {
    const pipeline = redis.pipeline()
    const now = Date.now() * 0x1000 // Match BullMQ's delayed job timestamp score encoding.

    for (const queue of queues) {
      pipeline.lindex(`bull:${queue}:wait`, -1)
      pipeline.llen(`bull:${queue}:wait`)
      pipeline.llen(`bull:${queue}:active`)
      pipeline.zcount(`bull:${queue}:delayed`, '-inf', now)
    }

    const results = await pipeline.exec()

    for (let i = 0; i < results.length; i += 4) {
      const lastWaitJob = results[i][1]
      const waitCount = results[i + 1][1] || 0
      const activeCount = results[i + 2][1] || 0
      const delayedCount = results[i + 3][1] || 0

      totalCount += waitCount + activeCount + delayedCount

      if (lastWaitJob && lastWaitJob.startsWith('0:')) {
        totalCount -= 1
      }
    }
  } finally {
    await redis.quit()
  }

  return totalCount
}

/**
 * Unpacks the arguments provided to jobQueueSize function.
 *
 * @param {Array} args - Arguments array.
 * @returns {object} An object containing queues and an options object.
 */
function unpack (args) {
  const lastArg = args[args.length - 1]
  let queues = []
  let options = {}

  if (typeof lastArg === 'object' && lastArg !== null && !Array.isArray(lastArg)) {
    queues = args.slice(0, -1)
    options = lastArg
  } else {
    queues = args
  }

  queues = queues.flat()

  return { queues, options }
}

module.exports = { jobQueueSize }
