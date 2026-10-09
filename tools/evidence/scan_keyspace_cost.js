"use strict"

const path = require("path")
const { library, report } = require("./support")

async function scans(redis) {
  const stats = await redis.info("commandstats")
  const match = stats.match(/cmdstat_scan:calls=(\d+)/)
  return match ? Number(match[1]) : 0
}

async function main() {
  const jobs = Number(process.argv[2] || 200000)
  const IORedis = require(require.resolve("ioredis", { paths: [library] }))
  const { jobQueueSize } = require(path.join(library, "src", "macro", "bullmq"))
  const url = process.env.REDIS_URL
  const redis = new IORedis(url)
  await redis.flushdb()
  await redis.lpush("bull:evidence:wait", "1", "2", "3")
  const empty = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = performance.now()
    await jobQueueSize({ connection: url })
    empty.push(Math.round(performance.now() - started))
  }
  for (let offset = 0; offset < jobs; offset += 10000) {
    const pipeline = redis.pipeline()
    for (let index = offset; index < offset + 10000; index += 1) {
      pipeline.hset(
        `bull:evidence:${index}`,
        "name",
        "job",
        "returnvalue",
        "null",
      )
    }
    await pipeline.exec()
  }
  const before = await scans(redis)
  const full = []
  let size
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = performance.now()
    size = await jobQueueSize({ connection: url })
    full.push(Math.round(performance.now() - started))
  }
  const calls = ((await scans(redis)) - before) / 2
  const named = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = performance.now()
    await jobQueueSize("evidence", { connection: url })
    named.push(Math.round(performance.now() - started))
  }
  await redis.flushdb()
  await redis.quit()
  report(
    "FINDING",
    "a size sample without queue names scans every key, and BullMQ keeps one hash per finished job",
    size === 3 && calls > jobs / 200,
    [
      `keys in the database: ${jobs} job hashes and one wait list of 3`,
      `SCAN calls per sample: ${calls}`,
      `sample without queue names: ${full[0]} ms and ${full[1]} ms (${empty[0]} ms and ${empty[1]} ms on the database with only the wait list)`,
      `sample with the queue named: ${named[0]} ms and ${named[1]} ms`,
    ],
  )
}

main()
