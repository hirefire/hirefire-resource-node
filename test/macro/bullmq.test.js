const sinon = require("sinon")
const { Queue } = require("bullmq")
const { jobQueueLatency, jobQueueSize } = require("../../src/macro/bullmq")
const {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
} = require("../../src/errors")
const IORedis = require("ioredis")

const redisURL = "redis://127.0.0.1:6379"

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
    defaultQueue = new Queue("default", { connection: redisURL })
    mailerQueue = new Queue("mailer", { connection: redisURL })
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

  test("jobQueueSize missing queue raises error", async () => {
    await expect(jobQueueSize()).rejects.toThrow(MissingQueueError)
  })

  test("jobQueueSize without jobs", async () => {
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(0)
  })

  test("jobQueueSize with jobs", async () => {
    await defaultQueue.add("testJob", {})
    await mailerQueue.add("testJob", {})
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
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(1)
    clock.tick(15_000)
    expect(await jobQueueSize("default", { conection: redisURL })).toBe(2)
    clock.tick(15_000)
    expect(await jobQueueSize("default", { connection: redisURL })).toBe(3)
  })
})
