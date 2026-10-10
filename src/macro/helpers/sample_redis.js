const sampleRound = require("../../sample_round")
const { unpack, normalizeQueues } = require("../../utility")

const WALK_PAGE = 1000
const WALK_BUDGET = 2
const SAMPLE_REDIS_OPTIONS = {
  maxRetriesPerRequest: 1,
  connectTimeout: 5000,
  commandTimeout: 5000,
  enableOfflineQueue: true,
  retryStrategy(times) {
    return times > 2 ? null : times * 50
  },
}

const ACTIVITY = `
local active = redis.call("LRANGE", KEYS[1], 0, -1)
local running = 0
for _, id in ipairs(active) do
  running = running + redis.call("EXISTS", ARGV[1] .. id .. ":lock")
end
return {#active, running}`

async function sample(args, states, commands, count) {
  const { queues: given, options } = unpack(args)
  const named = normalizeQueues(given, { allowEmpty: true })
  const redis = connect(options)
  let refused = null
  redis.on("error", (error) => {
    refused ??= error
  })

  try {
    const queues = named.length > 0 ? named : await discover(redis, states)
    const pipeline = redis.pipeline()
    for (const queue of queues) commands(pipeline, `bull:${queue}:`)

    const replies = (await pipeline.exec()).map(reply)
    const width = replies.length / queues.length
    let total = 0
    queues.forEach((_queue, index) => {
      total += count(replies.slice(index * width, (index + 1) * width))
    })
    return Math.max(0, total)
  } catch (error) {
    if (refused && refused !== error) {
      error.message = `${error.message} (${refused.message})`
    }
    throw error
  } finally {
    try {
      await redis.quit()
    } catch {
      redis.disconnect()
    }
  }
}

function activity(pipeline, key) {
  pipeline.eval(ACTIVITY, 1, `${key}active`, key)
}

function connect({ connection, connectionOptions }) {
  const target =
    connection ||
    process.env.REDIS_TLS_URL ||
    process.env.REDIS_URL ||
    process.env.REDISTOGO_URL ||
    process.env.REDISCLOUD_URL ||
    process.env.OPENREDIS_URL ||
    "redis://localhost:6379/0"

  if (typeof target.duplicate === "function") {
    return target.duplicate({ ...SAMPLE_REDIS_OPTIONS, ...connectionOptions })
  }

  const IORedis = require("ioredis")
  return typeof target === "object"
    ? new IORedis({ ...SAMPLE_REDIS_OPTIONS, ...target, ...connectionOptions })
    : new IORedis(target, {
        ...SAMPLE_REDIS_OPTIONS,
        ...herokuTls(target),
        ...connectionOptions,
      })
}

function herokuTls(url) {
  return process.env.DYNO && url.startsWith("rediss://")
    ? { tls: { rejectUnauthorized: false } }
    : {}
}

function discover(redis, states) {
  const round = sampleRound.getStore()
  if (!round) return walk(redis, states)

  const { host, port, path, db } = redis.options
  const key = [states, host, port, path, db].join("\0")
  if (!round.has(key)) round.set(key, walk(redis, states))
  return round.get(key)
}

async function walk(redis, states) {
  const queue = new RegExp(`^bull:(.*):(${states.join("|")})$`)
  const names = new Set()
  const deadline = performance.now() + WALK_BUDGET * 1000
  let cursor = "0"

  do {
    if (performance.now() > deadline) {
      throw new Error(
        `Listing the queues took more than ${WALK_BUDGET} seconds, because ` +
          "the Redis database holds many keys. Name the queues of this " +
          "sample, so that the keys are not walked.",
      )
    }

    const [next, keys] = await redis.scan(
      cursor,
      "MATCH",
      "bull:*",
      "COUNT",
      WALK_PAGE,
    )
    cursor = next
    for (const key of keys) {
      const match = queue.exec(key)
      if (match) names.add(match[1])
    }
  } while (cursor !== "0")

  return Array.from(names)
}

function reply([error, value]) {
  if (error) throw error
  return value
}

module.exports = { sample, activity }
