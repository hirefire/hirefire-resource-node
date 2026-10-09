"use strict"

const path = require("path")
const { library, report } = require("./support")

async function main() {
  const IORedis = require(require.resolve("ioredis", { paths: [library] }))
  const { jobQueueSize } = require(path.join(library, "src", "macro", "bullmq"))
  const url = process.env.REDIS_URL
  const app = new IORedis(url)
  await app.del("bull:evidence:wait")
  await app.lpush("bull:evidence:wait", "1", "2", "3")
  const byUrl = await jobQueueSize("evidence", { connection: url })
  let byInstance
  try {
    byInstance = await jobQueueSize("evidence", { connection: app })
  } catch (error) {
    byInstance = `rejected: ${error.message}`
  }
  await app.del("bull:evidence:wait")
  await app.quit()
  report(
    "FINDING",
    "an ioredis instance passed as connection is read as an options object, so the sample goes to the default host and not to the Redis of the instance",
    byUrl === 3 && byInstance !== 3,
    [
      `the Redis of the instance: ${new URL(url).host}`,
      `size with the URL as connection: ${byUrl}`,
      `size with the instance as connection: ${byInstance}`,
    ],
  )
}

main()
