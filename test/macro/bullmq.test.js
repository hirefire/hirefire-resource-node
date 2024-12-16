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
    await redis.flushdb()
    defaultQueue = new Queue("default", { connection: redis })
    mailerQueue = new Queue("mailer", { connection: redis })
    clock = sinon.useFakeTimers(Date.now())
  })

  afterEach(async () => {
    clock.restore()
    await defaultQueue.obliterate({ force: true })
    await mailerQueue.obliterate({ force: true })
    await defaultQueue.close()
    await mailerQueue.close()
  })

  test("jobQueueLatency throws unsupported error", async () => {
    await expect(jobQueueLatency()).rejects.toThrow(
      JobQueueLatencyUnsupportedError,
    )
  })

  test("returns 0 for empty queues", async () => {
    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(0)
    await expect(
      jobQueueSize("default", { connection: redisURL }),
    ).resolves.toBe(0)
  })

  test("counts jobs across all queues when no queue names specified", async () => {
    await defaultQueue.add("testJob", {})
    await mailerQueue.add("testJob", {})

    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(2)
  })

  test("counts jobs for specific queues", async () => {
    await defaultQueue.add("testJob", {})
    await mailerQueue.add("testJob", {})

    await expect(
      jobQueueSize("default", { connection: redisURL }),
    ).resolves.toBe(1)
    await expect(
      jobQueueSize("default", "mailer", { connection: redisURL }),
    ).resolves.toBe(2)
  })

  test("handles scheduled jobs correctly", async () => {
    await defaultQueue.add("pastScheduledJob", {}, { delay: 15_000 })
    await defaultQueue.add("pastScheduledJob", {}, { delay: 30_000 })
    await defaultQueue.add("pastScheduledJob")

    clock.tick(1)
    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(1)

    clock.tick(15_000)
    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(2)

    clock.tick(15_000)
    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(3)
  })

  test("counts prioritized jobs", async () => {
    await defaultQueue.add("normalJob", {})
    await defaultQueue.add("prioritizedJob", {}, { priority: 1 })
    await defaultQueue.add("highPriorityJob", {}, { priority: 2 })

    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(3)
  })

  test("handles parent/child jobs correctly", async () => {
    const parentJob = await defaultQueue.add("parentJob", {})
    await defaultQueue.add("childJob1", { parentId: parentJob.id })
    await defaultQueue.add("childJob2", { parentId: parentJob.id })
    await parentJob.moveToWaitingChildren()

    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(3)
  })

  test("excludes jobs in paused queues", async () => {
    await defaultQueue.add("normalJob", {})
    await mailerQueue.add("mailerJob", {})

    await defaultQueue.pause()
    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(1)

    await defaultQueue.resume()
    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(2)
  })

  test("handles grouped jobs correctly", async () => {
    await addGroupedJob(redis, "default", "group1")
    await addGroupedJob(redis, "default", "group2")
    await addPrioritizedGroupedJob(redis, "default", "group1", 1)
    await addPrioritizedGroupedJob(redis, "default", "group2", 2)

    await expect(jobQueueSize({ connection: redisURL })).resolves.toBe(4)
  })

  test("supports custom prefix", async () => {
    const customQueue = new Queue("default", {
      connection: redis,
      prefix: "custom",
    })

    await customQueue.add("normalJob", {})
    await expect(
      jobQueueSize({ connection: redisURL, prefix: "custom" }),
    ).resolves.toBe(1)

    await customQueue.obliterate({ force: true })
    await customQueue.close()
  })

  test("rejects empty prefix", async () => {
    await expect(
      jobQueueSize({ connection: redisURL, prefix: "" }),
    ).rejects.toThrow("Prefix cannot be empty")
  })
})

/**
 * Helper function that simulates BullMQ Pro's group job enqueuing behavior.
 * This is used solely for testing purposes since we don't have access to BullMQ Pro.
 * It manually creates the Redis data structure that BullMQ Pro would create for grouped jobs.
 */
async function addGroupedJob(redis, queue, groupId, prefix = "bull") {
  const jobId = await redis.incr(`${prefix}:${queue}:id`)
  const timestamp = Date.now()

  await redis.hset(`${prefix}:${queue}:${jobId}`, {
    name: "__default__",
    data: JSON.stringify({}),
    opts: JSON.stringify({ group: { id: groupId }, attempts: 0 }),
    timestamp: timestamp.toString(),
    delay: "0",
    priority: "0",
    gid: groupId,
  })

  await redis.lpush(`${prefix}:${queue}:groups:${groupId}`, jobId)
  await redis.zadd(`${prefix}:${queue}:groups`, 1, groupId)

  return jobId
}

/**
 * Helper function that simulates BullMQ Pro's prioritized group job enqueuing behavior.
 * This is used solely for testing purposes since we don't have access to BullMQ Pro.
 * It manually creates the Redis data structure that BullMQ Pro would create for
 * prioritized grouped jobs, including the priority score calculations.
 */
async function addPrioritizedGroupedJob(
  redis,
  queue,
  groupId,
  priority,
  prefix = "bull",
) {
  const jobId = await redis.incr(`${prefix}:${queue}:id`)
  const timestamp = Date.now()

  await redis.hset(`${prefix}:${queue}:${jobId}`, {
    name: "__default__",
    data: JSON.stringify({}),
    opts: JSON.stringify({ group: { id: groupId, priority }, attempts: 0 }),
    timestamp: timestamp.toString(),
    delay: "0",
    priority: priority.toString(),
    gid: groupId,
  })

  const score = 4294967296 + priority
  await redis.zadd(`${prefix}:${queue}:groups:${groupId}:p`, score, jobId)
  await redis.zadd(`${prefix}:${queue}:groups`, 1, groupId)
  await redis.hset(`${prefix}:${queue}:groups:pc`, groupId, "1")

  return jobId
}
