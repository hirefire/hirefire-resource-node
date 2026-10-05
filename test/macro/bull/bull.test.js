const Queue = require("bull")
const {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  beforeSampleJobQueues,
  afterSampleJobQueues,
} = require("../../../src/macro/bull")
const { JobQueueLatencyUnsupportedError } = require("../../../src/errors")
const Plan = require("../../../src/plan")
const Configuration = require("../../../src/configuration")
const IORedis = require("ioredis")
const { expectIntegerCount } = require("../numericTypes")

const redisURL = `redis://127.0.0.1:${process.env.REDIS_PORT || "6379"}/0`

describe("Bull", () => {
  let defaultQueue, mailerQueue, redis

  beforeEach(async () => {
    redis = new IORedis(redisURL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    })
    await redis.ping()
    await redis.flushdb()
    defaultQueue = new Queue("default", redisURL)
    mailerQueue = new Queue("mailer", redisURL)
    jest.useFakeTimers({
      now: Date.now(),
      doNotFake: [
        "nextTick",
        "setImmediate",
        "setInterval",
        "setTimeout",
        "clearInterval",
        "clearTimeout",
        "queueMicrotask",
        "hrtime",
        "performance",
      ],
    })
  })

  afterEach(async () => {
    jest.useRealTimers()
    try {
      if (defaultQueue) await defaultQueue.close()
    } finally {
      if (mailerQueue) await mailerQueue.close()
    }
    if (redis) {
      redis.disconnect()
      redis = null
    }
  })

  test("libraryLoaded is true when the bull package is imported", () => {
    expect(Plan.libraryLoaded("bull")).toBe(true)
    expect(Plan.executable("bull")).toBe(true)
    expect(Plan.anyAllowlistedJobQueueLibraryLoaded()).toBe(true)
  })

  test("jobQueueLatency is unsupported (async reject, not sync throw)", async () => {
    let threwSync = false
    let pending
    try {
      pending = jobQueueLatency("default", { connection: redisURL })
    } catch {
      threwSync = true
    }
    expect(threwSync).toBe(false)
    expect(pending).toBeInstanceOf(Promise)
    await expect(pending).rejects.toThrow(JobQueueLatencyUnsupportedError)
  })

  test("jobQueueSize without jobs", async () => {
    const size = await jobQueueSize({ connection: redisURL })
    expectIntegerCount(size)
    expect(size).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("all-queues wave cache does not reuse names across connectionOptions", async () => {
    await defaultQueue.add({})
    const alt = new IORedis(redisURL, { db: 1 })
    try {
      await alt.flushdb()
      await alt.rpush("bull:altq:wait", "1")
      beforeSampleJobQueues()
      try {
        expect(await jobQueueSize({ connection: redisURL })).toBe(1)
        expect(
          await jobQueueSize({
            connection: redisURL,
            connectionOptions: { db: 1 },
          }),
        ).toBe(1)
      } finally {
        afterSampleJobQueues()
      }
    } finally {
      await alt.flushdb()
      await alt.quit()
    }
  })

  test("jobQueueSize with jobs", async () => {
    await defaultQueue.add({})
    await mailerQueue.add({})
    const size = await jobQueueSize({ connection: redisURL })
    expectIntegerCount(size)
    expect(size).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(2)
  })

  test("jobQueueSize with jobs scheduled in the past", async () => {
    await defaultQueue.add({}, { delay: 15_000 })
    await defaultQueue.add({}, { delay: 30_000 })
    await defaultQueue.add({})
    jest.setSystemTime(Date.now() + 1)
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await redis.zcard("bull:default:delayed")).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.setSystemTime(Date.now() + 15_000)
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await redis.zcard("bull:default:delayed")).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.setSystemTime(Date.now() + 15_000)
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await redis.zcard("bull:default:delayed")).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize counts active jobs by default", async () => {
    await redis.lpush("bull:default:active", "job-active-1", "job-active-2")
    expect(await redis.llen("bull:default:active")).toBe(2)
    const size = await jobQueueSize("default", { connection: redisURL })
    expectIntegerCount(size)
    expect(size).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(
      await jobQueueSize("default", {
        connection: redisURL,
        skipWorking: false,
      }),
    ).toBe(2)
    expect(
      await jobQueueSize("default", {
        connection: redisURL,
        skipWorking: null,
      }),
    ).toBe(2)
  })

  test("jobQueueSize with skipWorking leaves active jobs out", async () => {
    await defaultQueue.add({})
    await redis.lpush("bull:default:active", "job-active-1", "job-active-2")
    expect(
      await jobQueueSize("default", {
        connection: redisURL,
        skipWorking: true,
      }),
    ).toBe(1)
    expect(
      await jobQueueSize({ connection: redisURL, skipWorking: true }),
    ).toBe(1)
  })

  test("jobQueueSize counts a job that a worker is processing", async () => {
    jest.useRealTimers()
    let release
    const held = new Promise((resolve) => {
      release = resolve
    })
    let started
    const processing = new Promise((resolve) => {
      started = resolve
    })
    defaultQueue.process(async () => {
      started()
      await held
    })
    try {
      await defaultQueue.add({})
      await processing
      expect(await jobQueueWorking("default", { connection: redisURL })).toBe(1)
      expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
      expect(
        await jobQueueSize("default", {
          connection: redisURL,
          skipWorking: true,
        }),
      ).toBe(0)
    } finally {
      release()
    }
  })

  test("jobQueueSize counts live, due delayed, and active jobs and no future delayed job", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({}, { delay: 1 })
    await defaultQueue.add({}, { delay: 60_000 })
    await redis.lpush("bull:default:active", "job-active-1", "job-active-2")
    jest.setSystemTime(Date.now() + 1)
    expect(await jobQueueSize({ connection: redisURL })).toBe(4)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(4)
    expect(
      await jobQueueSize("default", {
        connection: redisURL,
        skipWorking: true,
      }),
    ).toBe(2)
    expect(await redis.llen("bull:default:active")).toBe(2)
  })

  test("jobQueueSize sums active jobs across two queues in one call", async () => {
    await defaultQueue.add({})
    await redis.lpush("bull:default:active", "a1", "a2")
    await mailerQueue.add({})
    await mailerQueue.add({})
    await mailerQueue.add({})
    await redis.lpush("bull:mailer:active", "m1", "m2", "m3", "m4")
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(10)
    expect(
      await jobQueueSize("mailer", "default", { connection: redisURL }),
    ).toBe(10)
    expect(
      await jobQueueSize("default", "mailer", {
        connection: redisURL,
        skipWorking: true,
      }),
    ).toBe(4)
  })

  test("jobQueueSize excludes future delayed until due", async () => {
    await defaultQueue.add({}, { delay: 60_000 })
    expect(await redis.zcard("bull:default:delayed")).toBe(1)
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
    jest.setSystemTime(Date.now() + 60_000)
    expect(await redis.zcard("bull:default:delayed")).toBe(1)
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
  })

  test("jobQueueSize coerces stringNumbers counts to a number", async () => {
    await defaultQueue.add({})
    const count = await jobQueueSize("default", {
      connection: redisURL,
      connectionOptions: { stringNumbers: true },
    })
    expect(count).toBe(1)
    expect(typeof count).toBe("number")
  })

  test("jobQueueSize counts priority jobs once (not dual-write double-count)", async () => {
    await defaultQueue.add({}, { priority: 1 })
    await defaultQueue.add({}, { priority: 2 })
    await defaultQueue.add({})
    expect(await redis.llen("bull:default:wait")).toBe(3)
    expect(await redis.zcard("bull:default:priority")).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(await jobQueueSize({ connection: redisURL })).toBe(3)
  })

  test("jobQueueSize includes globally paused jobs", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({})
    await defaultQueue.pause()
    expect(await redis.llen("bull:default:paused")).toBe(2)
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
  })

  test("jobQueueSize does not subtract wait markers (classic Bull has none)", async () => {
    await redis.rpush("bull:default:wait", "0:123")
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
  })

  test("jobQueueSize excludes completed and failed terminal jobs", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({})
    await redis.zadd("bull:default:completed", Date.now(), "job-done-1")
    await redis.zadd("bull:default:failed", Date.now(), "job-fail-1")
    expect(await redis.zcard("bull:default:completed")).toBe(1)
    expect(await redis.zcard("bull:default:failed")).toBe(1)
    expect(await redis.llen("bull:default:wait")).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    await redis.del("bull:default:wait")
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize sums multi-queue wait and due delayed", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({})
    await mailerQueue.add({})
    await mailerQueue.add({}, { delay: 1 })
    jest.setSystemTime(Date.now() + 1)
    expect(await redis.llen("bull:default:wait")).toBe(2)
    expect(await redis.llen("bull:mailer:wait")).toBe(1)
    expect(await redis.zcard("bull:mailer:delayed")).toBe(1)
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(4)
    expect(await jobQueueSize({ connection: redisURL })).toBe(4)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(2)
  })

  test("jobQueueSize accepts object-form connection options", async () => {
    await defaultQueue.add({})
    const url = new URL(redisURL)
    const count = await jobQueueSize("default", {
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        db: Number((url.pathname || "/0").replace(/^\//, "") || 0),
      },
    })
    expect(count).toBe(1)
  })

  test("jobQueueSize uses REDIS_URL ladder and ignores HIREFIRE_BULL_URL", async () => {
    await defaultQueue.add({})
    const keys = [
      "REDIS_TLS_URL",
      "REDIS_URL",
      "REDISTOGO_URL",
      "REDISCLOUD_URL",
      "OPENREDIS_URL",
      "HIREFIRE_BULL_URL",
    ]
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      for (const k of keys) delete process.env[k]
      process.env.HIREFIRE_BULL_URL = "redis://127.0.0.1:1/0"
      process.env.REDIS_URL = redisURL
      expect(await jobQueueSize("default")).toBe(1)
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  test("all-queues discovery counts a queue that has only active jobs", async () => {
    await redis.lpush("bull:active-only:active", "job-a1", "job-a2")
    expect(await redis.llen("bull:active-only:active")).toBe(2)
    expect(await jobQueueSize("active-only", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(
      await jobQueueSize({ connection: redisURL, skipWorking: true }),
    ).toBe(0)
  })

  test("jobQueueSize priority-index-only state does not inflate JQS", async () => {
    await redis.zadd("bull:prio-only:priority", 1, "job-p1")
    expect(await redis.zcard("bull:prio-only:priority")).toBe(1)
    expect(await redis.llen("bull:prio-only:wait")).toBe(0)
    expect(await jobQueueSize("prio-only", { connection: redisURL })).toBe(0)
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
  })

  test("jobQueueSize drops blank and whitespace-only queue names", async () => {
    await defaultQueue.add({})
    await mailerQueue.add({})
    expect(
      await jobQueueSize("default", "  ", "", null, undefined, {
        connection: redisURL,
      }),
    ).toBe(1)
    expect(await jobQueueSize("  ", "", { connection: redisURL })).toBe(2)
  })

  test("jobQueueSize uses delayed score upper bound (due vs not-due boundary)", async () => {
    const frozenNow = 1_700_000_000_000
    const delayedUpper = (frozenNow + 1) * 0x1000 - 1
    jest.setSystemTime(frozenNow)

    await redis.zadd("bull:default:delayed", delayedUpper, "job-due-edge")
    await redis.zadd(
      "bull:default:delayed",
      delayedUpper + 1,
      "job-future-edge",
    )
    await redis.zadd("bull:default:delayed", frozenNow, "job-raw-epoch-score")
    expect(await redis.zcard("bull:default:delayed")).toBe(3)
    expect(await redis.llen("bull:default:wait")).toBe(0)

    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)

    jest.setSystemTime(frozenNow + 1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
  })

  test("jobQueueSize excludes repeatable configs and stalled bookkeeping keys", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({})
    await redis.zadd("bull:default:repeat", Date.now(), "repeat:cron:cfg")
    await redis.sadd("bull:default:stalled", "job-stalled-1")
    await redis.set("bull:default:stalled-check", "1")
    expect(await redis.zcard("bull:default:repeat")).toBe(1)
    expect(await redis.scard("bull:default:stalled")).toBe(1)
    expect(await redis.llen("bull:default:wait")).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    await redis.del("bull:default:wait")
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize counts priority jobs once after global pause", async () => {
    await defaultQueue.add({}, { priority: 1 })
    await defaultQueue.add({}, { priority: 5 })
    await defaultQueue.add({})
    await defaultQueue.pause()
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await redis.llen("bull:default:paused")).toBe(3)
    expect(await redis.zcard("bull:default:priority")).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
  })

  test("jobQueueSize rejects when Redis is unreachable", async () => {
    jest.useRealTimers()
    await expect(
      jobQueueSize({
        connection: "redis://127.0.0.1:1/0",
        connectionOptions: {
          maxRetriesPerRequest: 0,
          connectTimeout: 300,
          commandTimeout: 300,
          retryStrategy: () => null,
          enableOfflineQueue: false,
          lazyConnect: false,
        },
      }),
    ).rejects.toThrow()
  })

  test("jobQueueSize all-queues is 0 on empty Redis", async () => {
    await redis.flushdb()
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
  })

  test("jobQueueWorking idle is zero", async () => {
    const working = await jobQueueWorking({ connection: redisURL })
    expectIntegerCount(working)
    expect(working).toBe(0)
    expect(await jobQueueWorking("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueWorking counts active and filters queues", async () => {
    await redis.lpush("bull:default:active", "a1")
    await redis.lpush("bull:mailer:active", "m1", "m2")
    await defaultQueue.add({})

    const working = await jobQueueWorking({ connection: redisURL })
    expectIntegerCount(working)
    expect(working).toBe(3)
    expect(await jobQueueWorking("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueWorking("mailer", { connection: redisURL })).toBe(2)
    expect(await jobQueueWorking("critical", { connection: redisURL })).toBe(0)
    expect(
      await jobQueueWorking("default", "mailer", { connection: redisURL }),
    ).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(2)
  })

  test("plan execute bull jqs also samples wrk", async () => {
    await redis.lpush("bull:default:active", "a1", "a2")
    await defaultQueue.add({})

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULL_URL
    process.env.HIREFIRE_BULL_URL = redisURL
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bull",
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
      expect(jqs).toBe(3)
    } finally {
      if (prev === undefined) delete process.env.HIREFIRE_BULL_URL
      else process.env.HIREFIRE_BULL_URL = prev
    }
  })

  test("plan execute bull jqs with skip_working samples waiting jobs and still samples wrk", async () => {
    await redis.lpush("bull:default:active", "a1", "a2")
    await defaultQueue.add({})

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULL_URL
    process.env.HIREFIRE_BULL_URL = redisURL
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bull",
          strategy: "jqs",
          queues: ["default"],
          options: { skip_working: true },
        },
        configuration,
      )
      const flushed = configuration.buffer.flush()
      expect(Object.values(flushed.worker.jqs)[0]).toBe(1)
      expect(Object.values(flushed.worker.wrk)[0]).toBe(2)
      expect(configuration.logger.error).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.HIREFIRE_BULL_URL
      else process.env.HIREFIRE_BULL_URL = prev
    }
  })

  test("plan execute bull empty queues samples all wrk", async () => {
    await redis.lpush("bull:default:active", "a1")
    await redis.lpush("bull:mailer:active", "m1")

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULL_URL
    process.env.HIREFIRE_BULL_URL = redisURL
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bull",
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
      if (prev === undefined) delete process.env.HIREFIRE_BULL_URL
      else process.env.HIREFIRE_BULL_URL = prev
    }
  })
})
