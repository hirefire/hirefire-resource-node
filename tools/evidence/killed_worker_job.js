"use strict"

const path = require("path")
const { library, sleep, report } = require("./support")

async function main() {
  const { Queue, Worker } = require(
    require.resolve("bullmq", { paths: [library] }),
  )
  const macro = require(path.join(library, "src", "macro", "bullmq"))
  const url = new URL(process.env.REDIS_URL)
  const connection = {
    host: url.hostname,
    port: Number(url.port),
    maxRetriesPerRequest: null,
  }
  const queue = new Queue("evidence-killed", { connection })
  await queue.obliterate({ force: true })
  await queue.add("job", {})
  const worker = new Worker("evidence-killed", () => new Promise(() => {}), {
    connection,
    lockDuration: 1000,
    stalledInterval: 600000,
  })
  await sleep(500)
  await worker.close(true)
  await worker.disconnect()
  await sleep(2500)
  const options = { connection: process.env.REDIS_URL }
  const working = await macro.jobQueueWorking("evidence-killed", options)
  const waiting = await macro.jobQueueSize("evidence-killed", {
    ...options,
    skipWorking: true,
  })
  const IORedis = require(require.resolve("ioredis", { paths: [library] }))
  const client = new IORedis(process.env.REDIS_URL)
  const active = await client.lrange("bull:evidence-killed:active", 0, -1)
  const lock = await client.exists(`bull:evidence-killed:${active[0]}:lock`)
  await client.quit()
  await queue.obliterate({ force: true })
  await queue.close()
  report(
    "FINDING",
    "a BullMQ job whose worker is gone and whose lock expired still counts as running and not as waiting",
    working === 1 && waiting === 0 && lock === 0,
    [
      `workers alive: 0, lock key of the job present: ${lock === 1}`,
      `jobQueueWorking: ${working}`,
      `jobQueueSize with skipWorking: ${waiting}`,
    ],
  )
}

main()
