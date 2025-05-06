const sinon = require("sinon")
const { Queue } = require("bullmq")
const { jobQueueLatency, jobQueueSize } = require("../../src/macro/bullmq")
const { JobQueueLatencyUnsupportedError } = require("../../src/errors")
const IORedis = require("ioredis")

const redisURL = "redis://127.0.0.1:6379/15"

describe("BullMQ", () => {
  let defaultQueue, mailerQueue, clock, redis

  beforeAll(async () => {
    redis = new IORedis(redisURL)
  })

  afterAll(async () => {
    await redis.quit()
  })

  beforeEach(async () => {
    redis.flushdb()
    defaultQueue = new Queue("default", { connection: redis })
    mailerQueue = new Queue("mailer", { connection: redis })
    clock = sinon.useFakeTimers(Date.now())
  })

  afterEach(async () => {
    clock.restore()
    await defaultQueue.close()
    await mailerQueue.close()
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

  test("jobQueueSize with jobs scheduled in the past", async () => {
    await defaultQueue.add("pastScheduledJob", {}, { delay: 15_000 })
    await defaultQueue.add("pastScheduledJob", {}, { delay: 30_000 })
    await defaultQueue.add("pastScheduledJob")
    clock.tick(1)
    expect(await jobQueueSize({ connection: redisURL })).toBe(1)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    clock.tick(15_000)
    expect(await jobQueueSize({ connection: redisURL })).toBe(2)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(2)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
    clock.tick(15_000)
    expect(await jobQueueSize({ connection: redisURL })).toBe(3)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
    expect(await jobQueueSize("mailer", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize respects connectionOptions.stringNumbers", async () => {
    await defaultQueue.add("testJob", {})
    const count = await jobQueueSize("default", {
      connection: redisURL,
      connectionOptions: { stringNumbers: true },
    })
    expect(typeof count).toBe("string")
  })
})
