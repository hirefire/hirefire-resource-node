const { unpack, normalizeQueues } = require("../../utility")

const SAMPLE_REDIS_OPTIONS = {
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  commandTimeout: 5000,
  retryStrategy(times) {
    if (times > 2) return null
    return Math.min(times * 50, 200)
  },
}

function loadIORedis() {
  return require("ioredis")
}

function connectionEnumKey(connection, userConnectionOptions) {
  try {
    return JSON.stringify({ connection, userConnectionOptions })
  } catch {
    return "object"
  }
}

async function withSampleRedis(args, resolveQueueNames, fn) {
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
    return await fn(redis, queues)
  } finally {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }
}

module.exports = {
  SAMPLE_REDIS_OPTIONS,
  loadIORedis,
  connectionEnumKey,
  withSampleRedis,
}
