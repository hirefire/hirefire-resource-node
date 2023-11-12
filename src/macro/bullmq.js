const IORedis = require('ioredis')

async function jobQueueSize(...args) {
  const { queues, options } = unpack(args);
  const redis = new IORedis(
    options.connection ||
      process.env.REDIS_TLS_URL ||
      process.env.REDIS_URL ||
      'redis://localhost:6379'
  )
  let totalCount = 0

  try {
    const pipeline = redis.pipeline()
    const now = Date.now() * 0x1000 // Adjust 'now' to match BullMQ's delayed job timestamp score encoding

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

      totalCount = totalCount + waitCount + activeCount + delayedCount

      if (lastWaitJob && lastWaitJob.startsWith('0:')) {
        totalCount = totalCount - 1 // 0:timestamp in bull:<queue>:wait is not a job
      }
    }
  } finally {
    await redis.quit()
  }

  return totalCount
}

function unpack(args) {
  const lastArg = args[args.length - 1];
  let queues = [];
  let options = {};

  if (typeof lastArg === 'object' && lastArg !== null && !Array.isArray(lastArg)) {
    queues = args.slice(0, -1);
    options = lastArg;
  } else {
    queues = args;
  }

  queues = queues.flat();

  return { queues, options };
}

module.exports = { jobQueueSize }
