"use strict"

const path = require("path")
const { library, report } = require("./support")

async function stats(redis) {
  const text = await redis.info("commandstats")
  const calls = {}
  for (const match of text.matchAll(/cmdstat_(\w+):calls=(\d+)/g)) {
    calls[match[1]] = Number(match[2])
  }
  const server = await redis.info("stats")
  calls.connections = Number(
    server.match(/total_connections_received:(\d+)/)[1],
  )
  return calls
}

function delta(before, after) {
  const out = {}
  for (const key of Object.keys(after)) {
    const change = after[key] - (before[key] || 0)
    if (change > 0 && key !== "info") out[key] = change
  }
  return out
}

async function main() {
  const IORedis = require(require.resolve("ioredis", { paths: [library] }))
  const macro = require(path.join(library, "src", "macro", "bullmq"))
  const url = process.env.REDIS_URL
  const redis = new IORedis(url)
  const options = { connection: url }
  let before = await stats(redis)
  await macro.jobQueueSize("default", "mailers", options)
  const size = delta(before, await stats(redis))
  before = await stats(redis)
  await macro.jobQueueSize("default", "mailers", {
    ...options,
    skipWorking: true,
  })
  await macro.jobQueueWorking("default", "mailers", options)
  const plan = delta(before, await stats(redis))
  await redis.quit()
  report(
    "CHECK",
    "one BullMQ size sample of two named queues is one connection and one pipeline, and a plan entry with skip_working is two of each",
    size.connections === 1 && plan.connections === 2,
    [
      `jobQueueSize of two queues: ${JSON.stringify(size)}`,
      `the two calls of a plan entry with skip_working: ${JSON.stringify(
        plan,
      )}`,
    ],
  )
}

main()
