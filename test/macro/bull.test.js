const Queue = require("bull")
const { jobQueueLatency, jobQueueSize } = require("../../src/macro/bull")
const { JobQueueLatencyUnsupportedError } = require("../../src/errors")
const IORedis = require("ioredis")

const redisURL = `redis://127.0.0.1:${process.env.REDIS_PORT || "6379"}/0`

describe("Bull", () => {
  let defaultQueue, mailerQueue, redis

  beforeAll(async () => {
    redis = new IORedis(redisURL)
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    await redis.flushdb()
    defaultQueue = new Queue("default", redisURL)
    mailerQueue = new Queue("mailer", redisURL)
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate"],
      now: Date.now(),
    })
  })

  afterEach(async () => {
    jest.useRealTimers()
    // Close queues even if an earlier step failed so Redis connections do not leak.
    try {
      if (defaultQueue) await defaultQueue.close()
    } finally {
      if (mailerQueue) await mailerQueue.close()
    }
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
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize with jobs", async () => {
    await defaultQueue.add({})
    await mailerQueue.add({})
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(
      await jobQueueSize("default", "mailer", { connection: redisURL }),
    ).toBe(2)
  })

  test("jobQueueSize with jobs scheduled in the past", async () => {
    await defaultQueue.add({}, { delay: 15_000 })
    await defaultQueue.add({}, { delay: 30_000 })
    await defaultQueue.add({})
    jest.advanceTimersByTime(1)
    // Pin Redis locations so a promotion-only path cannot hide a missing ZCOUNT.
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await redis.zcard("bull:default:delayed")).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.advanceTimersByTime(15_000)
    // First delayed is due by score but still on the delayed zset until a worker promotes.
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await redis.zcard("bull:default:delayed")).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    jest.advanceTimersByTime(15_000)
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await redis.zcard("bull:default:delayed")).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize excludes active-only jobs", async () => {
    await redis.lpush("bull:default:active", "job-active-1", "job-active-2")
    expect(await redis.llen("bull:default:active")).toBe(2)
    // Named queue: active is present but not waiting.
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize counts waiting only when mixed with active", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({}, { delay: 1 })
    await redis.lpush("bull:default:active", "job-active-1")
    jest.advanceTimersByTime(1)
    // live wait + due delayed = 2. active excluded.
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await redis.llen("bull:default:active")).toBe(1)
  })

  test("jobQueueSize excludes future delayed until due", async () => {
    await defaultQueue.add({}, { delay: 60_000 })
    expect(await redis.zcard("bull:default:delayed")).toBe(1)
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
    jest.advanceTimersByTime(60_000)
    // Still on delayed zset; JQS includes it via due ZCOUNT, not LLEN wait.
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
    // Two priority jobs dual-write wait+priority. One plain wait job has no priority index.
    // wait=3, priority=2 → correct JQS is 3.
    // Wrong ZCARD-priority-only → 2. Wrong double-count wait+priority → 5.
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
    // BullMQ-shaped marker value: classic Bull must still count it (no LINDEX/0: strip).
    await redis.rpush("bull:default:wait", "0:123")
    expect(await redis.llen("bull:default:wait")).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
  })

  test("jobQueueSize excludes completed and failed terminal jobs", async () => {
    // Unequal cards: wait=2 vs completed=1 / failed=1 so ZCARD-only terminals
    // cannot alone match the expected JQS.
    await defaultQueue.add({})
    await defaultQueue.add({})
    await redis.zadd("bull:default:completed", Date.now(), "job-done-1")
    await redis.zadd("bull:default:failed", Date.now(), "job-fail-1")
    expect(await redis.zcard("bull:default:completed")).toBe(1)
    expect(await redis.zcard("bull:default:failed")).toBe(1)
    expect(await redis.llen("bull:default:wait")).toBe(2)
    // Terminal retention must not inflate waiting size.
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    // Terminals alone are not waiting.
    await redis.del("bull:default:wait")
    expect(await redis.llen("bull:default:wait")).toBe(0)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize sums multi-queue wait and due delayed", async () => {
    await defaultQueue.add({})
    await defaultQueue.add({})
    await mailerQueue.add({})
    await mailerQueue.add({}, { delay: 1 })
    jest.advanceTimersByTime(1)
    expect(await redis.llen("bull:default:wait")).toBe(2)
    expect(await redis.llen("bull:mailer:wait")).toBe(1)
    expect(await redis.zcard("bull:mailer:delayed")).toBe(1)
    // 2 wait (default) + 1 wait (mailer) + 1 due delayed (mailer) = 4
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
      // Unreachable override: jobQueueSize must not read HIREFIRE_BULL_URL.
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

  test("jobQueueSize active-only jobs do not inflate JQS", async () => {
    // Named + all-queues: active is working, not waiting. SCAN discovery of
    // active-only queue names is pinned in bull-quit (pipeline key spies).
    await redis.lpush("bull:active-only:active", "job-a1", "job-a2")
    expect(await redis.llen("bull:active-only:active")).toBe(2)
    expect(
      await jobQueueSize("active-only", { connection: redisURL }),
    ).toBe(0)
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
  })

  test("jobQueueSize priority-index-only state does not inflate JQS", async () => {
    // Priority index without dual-write wait members (edge race / partial state).
    // Discovery of priority-only names is pinned in bull-quit.
    await redis.zadd("bull:prio-only:priority", 1, "job-p1")
    expect(await redis.zcard("bull:prio-only:priority")).toBe(1)
    expect(await redis.llen("bull:prio-only:wait")).toBe(0)
    expect(await jobQueueSize("prio-only", { connection: redisURL })).toBe(0)
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
  })

  test("jobQueueSize drops blank and whitespace-only queue names", async () => {
    await defaultQueue.add({})
    await mailerQueue.add({})
    // Blank names normalize away; only default is sampled.
    expect(
      await jobQueueSize("default", "  ", "", null, undefined, {
        connection: redisURL,
      }),
    ).toBe(1)
    expect(await jobQueueSize("  ", "", { connection: redisURL })).toBe(2)
  })

  test("jobQueueSize uses delayed score upper bound (due vs not-due boundary)", async () => {
    // Classic Bull score = timestampMs * 0x1000 + nibble. HireFire upper =
    // (now + 1) * 0x1000 - 1. Seed raw scores so Bull delay timers cannot mask a
    // wrong bound (e.g. raw epoch ms as max).
    const frozenNow = 1_700_000_000_000
    const delayedUpper = (frozenNow + 1) * 0x1000 - 1
    jest.setSystemTime(frozenNow)

    await redis.zadd("bull:default:delayed", delayedUpper, "job-due-edge")
    await redis.zadd("bull:default:delayed", delayedUpper + 1, "job-future-edge")
    // Raw epoch as score would look "due" under a broken max=Date.now() bound.
    await redis.zadd("bull:default:delayed", frozenNow, "job-raw-epoch-score")
    expect(await redis.zcard("bull:default:delayed")).toBe(3)
    expect(await redis.llen("bull:default:wait")).toBe(0)

    // Due edge + raw-epoch score (also ≤ upper). Future edge excluded.
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)

    jest.setSystemTime(frozenNow + 1)
    // After +1ms, previous future edge is now within (now+1)*0x1000-1.
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
  })

  test("jobQueueSize excludes repeatable configs and stalled bookkeeping keys", async () => {
    // wait=2 vs repeat=1 / stalled=1 so SCARD/ZCARD of bookkeeping alone
    // cannot match expected JQS.
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
    // Bookkeeping alone is not waiting.
    await redis.del("bull:default:wait")
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize counts priority jobs once after global pause", async () => {
    // Two priority + one plain, then pause → paused=3, priority=2, JQS=3.
    // Priority-only ZCARD → 2. Double-count paused+priority → 5.
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
    // Connection timeouts use real timers (fake timers stall ioredis).
    // All-queues path must SCAN first; with offline queue off, an unreachable
    // host rejects instead of soft-zeroing pipeline field errors.
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
    // beforeEach flushes; no Queue keys remain if we only sample without adds.
    // Close queues first would drop their meta keys on close in some versions;
    // flushdb already wiped. Explicit re-flush for this case.
    await redis.flushdb()
    expect(await jobQueueSize({ connection: redisURL })).toBe(0)
  })
})
