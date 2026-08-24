const { Queue } = require("bullmq")
const {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
} = require("../../src/macro/bullmq")
const { JobQueueLatencyUnsupportedError } = require("../../src/errors")
const Plan = require("../../src/plan")
const Configuration = require("../../src/configuration")
const IORedis = require("ioredis")

const redisURL = `redis://127.0.0.1:${process.env.REDIS_PORT || "6379"}/0`

describe("BullMQ", () => {
  let defaultQueue, mailerQueue, redis

  beforeAll(async () => {
    redis = new IORedis(redisURL)
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    await redis.flushdb()
    defaultQueue = new Queue("default", { connection: redis })
    mailerQueue = new Queue("mailer", { connection: redis })
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate"],
      now: Date.now(),
    })
  })

  afterEach(async () => {
    jest.useRealTimers()
    await defaultQueue.close()
    await mailerQueue.close()
  })

  test("libraryLoaded is true when the bullmq package is imported", () => {
    expect(Plan.libraryLoaded("bullmq")).toBe(true)
    expect(Plan.executable("bullmq")).toBe(true)
    expect(Plan.anyAllowlistedJobQueueLibraryLoaded()).toBe(true)
  })

  test("jobQueueLatency is unsupported", async () => {
    await expect(jobQueueLatency()).rejects.toThrow(
      JobQueueLatencyUnsupportedError,
    )
  })

  test("jobQueueSize without jobs", async () => {
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize with jobs", async () => {
    await defaultQueue.add("testJob", {})
    await mailerQueue.add("testJob", {})
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(2)
  })

  test("jobQueueSize includes paused jobs", async () => {
    await defaultQueue.add("liveJob", {})
    await defaultQueue.pause()
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
  })

  test("jobQueueSize counts prioritized jobs once", async () => {
    await defaultQueue.add("prioJob", {}, { priority: 1 })
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
  })

  test("jobQueueSize uses REDIS_URL ladder and ignores HIREFIRE_BULLMQ_URL", async () => {
    await defaultQueue.add("liveJob", {})
    const keys = [
      "REDIS_TLS_URL",
      "REDIS_URL",
      "REDISTOGO_URL",
      "REDISCLOUD_URL",
      "OPENREDIS_URL",
      "HIREFIRE_BULLMQ_URL",
    ]
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      for (const k of keys) delete process.env[k]
      process.env.HIREFIRE_BULLMQ_URL = "redis://127.0.0.1:1/0"
      process.env.REDIS_URL = redisURL
      expect(await jobQueueSize("default")).toBe(1)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  test("jobQueueSize with jobs scheduled in the past", async () => {
    await defaultQueue.add("pastScheduledJob", {}, { delay: 15_000 })
    await defaultQueue.add("pastScheduledJob", {}, { delay: 30_000 })
    await defaultQueue.add("pastScheduledJob")
    jest.advanceTimersByTime(1)
    expect(await jobQueueSize({ connection: redisURL })).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.advanceTimersByTime(15_000)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.advanceTimersByTime(15_000)
    expect(await jobQueueSize({ connection: redisURL })).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize excludes active-only jobs", async () => {
    await redis.lpush("bull:default:active", "job-active-1", "job-active-2")
    expect(await redis.llen("bull:default:active")).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize counts waiting only when mixed with active", async () => {
    await defaultQueue.add("liveJob", {})
    await defaultQueue.add("dueDelayedJob", {}, { delay: 1 })
    await redis.lpush("bull:default:active", "job-active-1")
    jest.advanceTimersByTime(1)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await redis.llen("bull:default:active")).toBe(1)
  })

  test("jobQueueSize excludes future delayed until due", async () => {
    await defaultQueue.add("futureDelayedJob", {}, { delay: 60_000 })
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
    jest.advanceTimersByTime(60_000)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
  })

  test("jobQueueSize coerces stringNumbers counts to a number", async () => {
    await defaultQueue.add("testJob", {})
    const count = await jobQueueSize("default", {
      connection: redisURL,
      connectionOptions: { stringNumbers: true },
    })
    expect(count).toBe(1)
    expect(typeof count).toBe("number")
  })

  test("jobQueueWorking idle is zero", async () => {
    expect(await jobQueueWorking({ connection: redisURL })).toBe(0)
    expect(await jobQueueWorking("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueWorking counts active and filters queues", async () => {
    await redis.lpush("bull:default:active", "a1")
    await redis.lpush("bull:mailer:active", "m1", "m2")
    await defaultQueue.add("liveJob", {})

    expect(await jobQueueWorking({ connection: redisURL })).toBe(3)
    expect(await jobQueueWorking("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueWorking("mailer", { connection: redisURL })).toBe(2)
    expect(await jobQueueWorking("critical", { connection: redisURL })).toBe(0)
    expect(
      await jobQueueWorking("default", "mailer", { connection: redisURL }),
    ).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
  })

  test("plan execute bullmq jqs also samples wrk", async () => {
    await redis.lpush("bull:default:active", "a1", "a2")
    await defaultQueue.add("liveJob", {})

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULLMQ_URL
    process.env.HIREFIRE_BULLMQ_URL = redisURL
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const flushed = configuration.buffer.flush()
      expect(flushed.worker.jqs).toBeDefined()
      expect(flushed.worker.wrk).toBeDefined()
      const jqs = Object.values(flushed.worker.jqs)[0]
      const wrk = Object.values(flushed.worker.wrk)[0]
      expect(jqs).toBe(await jobQueueSize("default", { connection: redisURL }))
      expect(wrk).toBe(
        await jobQueueWorking("default", { connection: redisURL }),
      )
      expect(wrk).toBe(2)
      expect(jqs).toBe(1)
    } finally {
      if (prev === undefined) delete process.env.HIREFIRE_BULLMQ_URL
      else process.env.HIREFIRE_BULLMQ_URL = prev
    }
  })

  test("plan execute bullmq empty queues samples all wrk", async () => {
    await redis.lpush("bull:default:active", "a1")
    await redis.lpush("bull:mailer:active", "m1")

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULLMQ_URL
    process.env.HIREFIRE_BULLMQ_URL = redisURL
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: [],
        },
        configuration,
      )
      const flushed = configuration.buffer.flush()
      const wrk = Object.values(flushed.worker.wrk)[0]
      expect(wrk).toBe(2)
      expect(wrk).toBe(await jobQueueWorking({ connection: redisURL }))
    } finally {
      if (prev === undefined) delete process.env.HIREFIRE_BULLMQ_URL
      else process.env.HIREFIRE_BULLMQ_URL = prev
    }
  })
})
