const {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../errors")
const SizeOnly = require("../plan/size_only")
const Hooks = require("../plan/hooks")
const { withSampleRedis } = require("./helpers/sample_redis")

let waveEnumCache = null

async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("Bull")
}

function beforeSampleJobQueues() {
  waveEnumCache = new Map()
  return true
}

function afterSampleJobQueues(_token) {
  waveEnumCache = null
}

function reinitAfterFork() {
  waveEnumCache = null
}

async function resolveQueueNames(redis, queues, cacheKey) {
  if (queues.length > 0) return queues
  if (waveEnumCache && waveEnumCache.has(cacheKey)) {
    return waveEnumCache.get(cacheKey)
  }
  const names = await enumerateQueues(redis)
  if (waveEnumCache) waveEnumCache.set(cacheKey, names)
  return names
}

async function jobQueueSize(...args) {
  return withSampleRedis(args, resolveQueueNames, async (redis, queues) => {
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

    return Math.max(0, totalCount)
  })
}

async function jobQueueWorking(...args) {
  return withSampleRedis(args, resolveQueueNames, async (redis, queues) => {
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
  })
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
  if (err) throw err
  return value
}

function toCount(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function planOptions(_strategy, _options) {
  return {}
}

function planConnectionOptions() {
  const raw = process.env.HIREFIRE_BULL_URL
  if (raw == null) return {}
  const url = String(raw).trim()
  if (!url) return {}
  return { connection: url }
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  JobQueueLatencyUnsupportedError,
  planOptions,
  planConnectionOptions,
  supportsPlanStrategy: SizeOnly.supportsPlanStrategy,
  queuesRequired: Hooks.queuesRequired,
  beforeSampleJobQueues,
  afterSampleJobQueues,
  reinitAfterFork,
}
