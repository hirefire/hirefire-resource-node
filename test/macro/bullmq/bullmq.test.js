const { Queue, Worker } = require("bullmq")
const {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
} = require("../../../src/macro/bullmq")
const { JobQueueLatencyUnsupportedError } = require("../../../src/errors")
const Plan = require("../../../src/plan")
const sampleRound = require("../../../src/sample_round")
const Sampler = require("../../../src/sampler")
const Configuration = require("../../../src/configuration")
const IORedis = require("ioredis")
const { expectIntegerCount } = require("../numericTypes")

const redisPort = Number(process.env.REDIS_PORT || "6379")
const redisURL = `redis://127.0.0.1:${redisPort}/0`

function queueConnection() {
  return {
    host: "127.0.0.1",
    port: redisPort,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  }
}

describe("BullMQ", () => {
  let defaultQueue, mailerQueue, redis

  beforeEach(async () => {
    redis = new IORedis(redisURL, {
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
    })
    await redis.ping()
    await redis.flushdb()
    defaultQueue = new Queue("default", { connection: queueConnection() })
    mailerQueue = new Queue("mailer", { connection: queueConnection() })
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

  async function running(queue, ...ids) {
    await redis.lpush(`bull:${queue}:active`, ...ids)
    for (const id of ids) await redis.set(`bull:${queue}:${id}:lock`, "token")
  }

  afterEach(async () => {
    jest.useRealTimers()
    for (const queue of [defaultQueue, mailerQueue]) {
      if (!queue) continue
      await queue.close()
      if (typeof queue.disconnect === "function") {
        await queue.disconnect()
      }
    }
    if (redis) {
      redis.disconnect()
      redis = null
    }
  })

  test("libraryLoaded is true when the bullmq package is imported", () => {
    expect(Plan.ADAPTERS.bullmq.libraryLoaded()).toBe(true)
    expect(Plan.anyLibraryLoaded()).toBe(true)
  })

  test("jobQueueLatency is unsupported", async () => {
    await expect(jobQueueLatency()).rejects.toThrow(
      JobQueueLatencyUnsupportedError,
    )
    await expect(jobQueueLatency()).rejects.toThrow(
      "BullMQ currently does not support job queue latency measurements.",
    )
  })

  test("jobQueueSize without jobs", async () => {
    const size = await jobQueueSize({ connection: redisURL })
    expectIntegerCount(size)
    expect(size).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize with jobs", async () => {
    await defaultQueue.add("testJob", {})
    await mailerQueue.add("testJob", {})
    const size = await jobQueueSize({ connection: redisURL })
    expectIntegerCount(size)
    expect(size).toBe(2)
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

  test("jobQueueSize does not count a paused-list marker as a job", async () => {
    await defaultQueue.add("plainJob", {})
    await redis.rpush("bull:default:paused", "0:0")
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
    jest.setSystemTime(Date.now() + 1)
    expect(await jobQueueSize({ connection: redisURL })).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.setSystemTime(Date.now() + 15_000)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.setSystemTime(Date.now() + 15_000)
    expect(await jobQueueSize({ connection: redisURL })).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize counts active jobs by default", async () => {
    await running("default", "job-active-1", "job-active-2")
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
    await defaultQueue.add("liveJob", {})
    await running("default", "job-active-1", "job-active-2")
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
    const worker = new Worker(
      "default",
      async () => {
        started()
        await held
      },
      { connection: queueConnection() },
    )
    try {
      await defaultQueue.add("heldJob", {})
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
      await worker.close()
    }
  })

  test("an active job without its lock counts as waiting and not as running", async () => {
    await running("default", "held")
    await redis.lpush("bull:default:active", "orphan-1", "orphan-2")
    await running("mailer", "held-1", "held-2")
    await redis.lpush("bull:mailer:active", "orphan-3")

    expect(await jobQueueWorking("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueWorking({ connection: redisURL })).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(
      await jobQueueSize("default", {
        connection: redisURL,
        skipWorking: true,
      }),
    ).toBe(2)
    expect(
      await jobQueueSize({ connection: redisURL, skipWorking: true }),
    ).toBe(3)
  })

  test("the job of a worker that is gone counts as waiting once its lock expired", async () => {
    jest.useRealTimers()
    let started
    const processing = new Promise((resolve) => {
      started = resolve
    })
    const worker = new Worker(
      "default",
      () => {
        started()
        return new Promise(() => {})
      },
      {
        connection: queueConnection(),
        lockDuration: 500,
        stalledInterval: 600_000,
      },
    )
    await defaultQueue.add("orphan", {})
    await processing
    await worker.close(true)
    const [id] = await redis.lrange("bull:default:active", 0, -1)
    while (await redis.exists(`bull:default:${id}:lock`)) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(await jobQueueWorking("default", { connection: redisURL })).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(
      await jobQueueSize("default", {
        connection: redisURL,
        skipWorking: true,
      }),
    ).toBe(1)
  })

  test("all-queues discovery includes queues that hold only delayed or only paused jobs", async () => {
    await redis.zadd("bull:delayed-only:delayed", 4096, "job-delayed-1")
    expect(await jobQueueSize({ connection: redisURL })).toBe(1)

    await redis.rpush("bull:paused-only:paused", "job-paused-1")
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
  })

  test("all-queues discovery includes active-only and prioritized-only queues", async () => {
    await running("active-only", "job-active-1")
    await redis.zadd("bull:prioritized-only:prioritized", 1, "job-priority-1")

    expect(await jobQueueWorking({ connection: redisURL })).toBe(1)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(
      await jobQueueSize({ connection: redisURL, skipWorking: true }),
    ).toBe(1)
  })

  test("a database with 5,000 job hashes is walked in pages of 1,000 keys", async () => {
    async function scans() {
      const stats = await redis.info("commandstats")
      const match = stats.match(/cmdstat_scan:calls=(\d+)/)
      return match ? Number(match[1]) : 0
    }
    await redis.lpush("bull:default:wait", "1", "2", "3")
    for (let offset = 0; offset < 5000; offset += 1000) {
      const pipeline = redis.pipeline()
      for (let index = offset; index < offset + 1000; index += 1) {
        pipeline.hset(`bull:default:${index}`, "name", "job")
      }
      await pipeline.exec()
    }
    const before = await scans()

    expect(await jobQueueSize({ connection: redisURL })).toBe(3)

    const calls = (await scans()) - before
    expect(calls).toBeGreaterThanOrEqual(5)
    expect(calls).toBeLessThanOrEqual(10)
  })

  test("jobQueueSize counts live, due delayed, and active jobs and no future delayed job", async () => {
    await defaultQueue.add("liveJob", {})
    await defaultQueue.add("dueDelayedJob", {}, { delay: 1 })
    await defaultQueue.add("futureDelayedJob", {}, { delay: 60_000 })
    await running("default", "job-active-1", "job-active-2")
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
    await defaultQueue.add("liveJob", {})
    await running("default", "a1", "a2")
    await mailerQueue.add("liveJob", {})
    await mailerQueue.add("liveJob", {})
    await mailerQueue.add("liveJob", {})
    await mailerQueue.add("prioJob", {}, { priority: 1 })
    await running("mailer", "m1", "m2", "m3", "m4")
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(11)
    expect(
      await jobQueueSize("mailer", "default", { connection: redisURL }),
    ).toBe(11)
    expect(
      await jobQueueSize("default", "mailer", {
        connection: redisURL,
        skipWorking: true,
      }),
    ).toBe(5)
  })

  test("jobQueueSize excludes future delayed until due", async () => {
    await defaultQueue.add("futureDelayedJob", {}, { delay: 60_000 })
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
    jest.setSystemTime(Date.now() + 60_000)
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

  test("jobQueueSize excludes completed and failed terminal jobs", async () => {
    await defaultQueue.add("liveJob", {})
    await defaultQueue.add("liveJob", {})
    await redis.zadd("bull:default:completed", Date.now(), "job-done-1")
    await redis.zadd("bull:default:failed", Date.now(), "job-fail-1")
    expect(await redis.zcard("bull:default:completed")).toBe(1)
    expect(await redis.zcard("bull:default:failed")).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    await redis.del("bull:default:wait")
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize sums multi-queue wait and due delayed", async () => {
    await defaultQueue.add("liveJob", {})
    await defaultQueue.add("liveJob", {})
    await mailerQueue.add("liveJob", {})
    await mailerQueue.add("dueDelayedJob", {}, { delay: 1 })
    jest.setSystemTime(Date.now() + 1)
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(4)
    expect(await jobQueueSize({ connection: redisURL })).toBe(4)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(2)
  })

  test("jobQueueSize accepts object-form connection options", async () => {
    await defaultQueue.add("liveJob", {})
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

  test("jobQueueSize reads the Redis of an ioredis client that is passed as the connection", async () => {
    await redis.lpush("bull:default:wait", "1", "2", "3")
    const app = new IORedis(redisURL, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
    })
    try {
      await app.ping().catch(() => {})
      await new Promise((resolve) => setImmediate(resolve))

      expect(await jobQueueSize("default", { connection: app })).toBe(3)
      expect(await jobQueueSize({ connection: app })).toBe(3)
      expect(app.status).toBe("ready")
    } finally {
      app.disconnect()
    }
  })

  test("jobQueueSize drops blank and whitespace-only queue names", async () => {
    await defaultQueue.add("liveJob", {})
    await mailerQueue.add("liveJob", {})
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
    await redis.zadd(
      "bull:default:delayed",
      frozenNow * 0x1000,
      "job-packed-due",
    )
    await redis.zadd(
      "bull:default:delayed",
      (frozenNow + 60_000) * 0x1000,
      "job-packed-future",
    )
    expect(await redis.zcard("bull:default:delayed")).toBe(4)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
  })

  test("jobQueueSize excludes repeatable configs and stalled bookkeeping keys", async () => {
    await defaultQueue.add("liveJob", {})
    await defaultQueue.add("liveJob", {})
    await redis.zadd("bull:default:repeat", Date.now(), "repeat:cron:cfg")
    await redis.sadd("bull:default:stalled", "job-stalled-1")
    await redis.set("bull:default:stalled-check", "1")
    expect(await redis.zcard("bull:default:repeat")).toBe(1)
    expect(await redis.scard("bull:default:stalled")).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    await redis.del("bull:default:wait")
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("a sample round does not reuse the queue names of another database", async () => {
    await defaultQueue.add("liveJob", {})
    const alt = new IORedis(redisURL, { db: 1 })
    try {
      await alt.flushdb()
      await alt.rpush("bull:altq:wait", "1")
      await sampleRound.run(new Map(), async () => {
        expect(await jobQueueSize({ connection: redisURL })).toBe(1)
        expect(
          await jobQueueSize({
            connection: redisURL,
            connectionOptions: { db: 1 },
          }),
        ).toBe(1)
      })
    } finally {
      await alt.flushdb()
      await alt.quit()
    }
  })

  test("jobQueueSize counts priority jobs once after global pause", async () => {
    await defaultQueue.add("prioJob", {}, { priority: 1 })
    await defaultQueue.add("prioJob", {}, { priority: 5 })
    await defaultQueue.add("plainJob", {})
    await defaultQueue.pause()
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
  })

  test("jobQueueSize rejects when Redis is unreachable", async () => {
    jest.useRealTimers()
    await expect(
      jobQueueSize({ connection: "redis://127.0.0.1:1/0" }),
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
    await running("default", "a1")
    await running("mailer", "m1", "m2")
    await defaultQueue.add("liveJob", {})

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

  test("plan execute bullmq jqs counts running jobs and samples no wrk", async () => {
    await running("default", "a1", "a2")
    await defaultQueue.add("liveJob", {})

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULLMQ_URL
    process.env.HIREFIRE_BULLMQ_URL = redisURL
    try {
      await new Sampler(configuration).round(
        [
          {
            name: "worker",
            adapter: "bullmq",
            strategy: "jqs",
            queues: ["default"],
          },
        ],
        () => true,
      )
      const flushed = configuration.buffer.flush()
      expect(flushed.worker.jqs).toBeDefined()
      expect(flushed.worker.wrk).toBeUndefined()
      const jqs = Object.values(flushed.worker.jqs)[0]
      expect(jqs).toBe(await jobQueueSize("default", { connection: redisURL }))
      expect(await jobQueueWorking("default", { connection: redisURL })).toBe(2)
      expect(jqs).toBe(3)
    } finally {
      if (prev === undefined) delete process.env.HIREFIRE_BULLMQ_URL
      else process.env.HIREFIRE_BULLMQ_URL = prev
    }
  })

  test("plan execute bullmq jqs with skip_working samples waiting jobs and still samples wrk", async () => {
    await running("default", "a1", "a2")
    await defaultQueue.add("liveJob", {})

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULLMQ_URL
    process.env.HIREFIRE_BULLMQ_URL = redisURL
    try {
      await new Sampler(configuration).round(
        [
          {
            name: "worker",
            adapter: "bullmq",
            strategy: "jqs",
            queues: ["default"],
            options: { skip_working: true },
          },
        ],
        () => true,
      )
      const flushed = configuration.buffer.flush()
      expect(Object.values(flushed.worker.jqs)[0]).toBe(1)
      expect(Object.values(flushed.worker.wrk)[0]).toBe(2)
      expect(configuration.logger.error).not.toHaveBeenCalled()
    } finally {
      if (prev === undefined) delete process.env.HIREFIRE_BULLMQ_URL
      else process.env.HIREFIRE_BULLMQ_URL = prev
    }
  })

  test("plan execute bullmq empty queues samples all wrk", async () => {
    await running("default", "a1")
    await running("mailer", "m1")

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
    const prev = process.env.HIREFIRE_BULLMQ_URL
    process.env.HIREFIRE_BULLMQ_URL = redisURL
    try {
      await new Sampler(configuration).round(
        [
          {
            name: "worker",
            adapter: "bullmq",
            strategy: "jqs",
            queues: [],
            options: { skip_working: true },
          },
        ],
        () => true,
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
