const { unpack, normalizeQueues } = require("../utility")
const {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../errors")
const SizeOnly = require("../plan/size_only")

function loadIORedis() {
  return require("ioredis")
}

let waveEnumCache = null

async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("BullMQ")
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

function connectionEnumKey(connection, userConnectionOptions) {
  try {
    return JSON.stringify({ connection, userConnectionOptions })
  } catch {
    return "object"
  }
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
  queues = normalizeQueues(queues, { allowEmpty: true })

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
    queues = await resolveQueueNames(
      redis,
      queues,
      connectionEnumKey(connection, userConnectionOptions),
    )

    let totalCount = 0
    const pipeline = redis.pipeline()
    const delayedUpper = (Date.now() + 1) * 0x1000 - 1
    const cmdsPerQueue = 6

    for (const queue of queues) {
      pipeline.lindex(`bull:${queue}:wait`, -1)
      pipeline.llen(`bull:${queue}:wait`)
      pipeline.llen(`bull:${queue}:paused`)
      pipeline.lindex(`bull:${queue}:paused`, -1)
      pipeline.zcount(`bull:${queue}:delayed`, "-inf", delayedUpper)
      pipeline.zcard(`bull:${queue}:prioritized`)
    }

    const results = await pipeline.exec()
    if (!results) return 0

    for (let i = 0; i < results.length; i += cmdsPerQueue) {
      const lastWaitJob = pipelineValue(results[i])
      const waitCount = toCount(pipelineValue(results[i + 1]))
      const pausedCount = toCount(pipelineValue(results[i + 2]))
      const lastPausedJob = pipelineValue(results[i + 3])
      const delayedCount = toCount(pipelineValue(results[i + 4]))
      const prioritizedCount = toCount(pipelineValue(results[i + 5]))

      totalCount += waitCount + pausedCount + delayedCount + prioritizedCount

      const waitMarker =
        typeof lastWaitJob === "string" && lastWaitJob.startsWith("0:")
      const pausedMarker =
        typeof lastPausedJob === "string" && lastPausedJob.startsWith("0:")
      if (waitMarker || pausedMarker) {
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

async function jobQueueWorking(...args) {
  const IORedis = loadIORedis()
  let { queues, options } = unpack(args)
  queues = normalizeQueues(queues, { allowEmpty: true })

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
    queues = await resolveQueueNames(
      redis,
      queues,
      connectionEnumKey(connection, userConnectionOptions),
    )

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
        /^bull:(.*):(wait|paused|active|delayed|prioritized)$/,
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
  const raw = process.env.HIREFIRE_BULLMQ_URL
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
  beforeSampleJobQueues,
  afterSampleJobQueues,
  reinitAfterFork,
}
