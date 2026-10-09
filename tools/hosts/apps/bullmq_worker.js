"use strict"

const { Queue, Worker } = require("bullmq")
const HireFire = require("hirefire-resource")

const url = new URL(process.env.REDIS_URL)
const connection = {
  host: url.hostname,
  port: Number(url.port),
  maxRetriesPerRequest: null,
}
HireFire.configure(() => {})
console.log(
  `[host] pid=${
    process.pid
  } running=${HireFire.configuration.dispatcher.running()}`,
)
const queue = new Queue("default", { connection })
;(async () => {
  for (let index = 0; index < 5; index += 1) await queue.add("job", {})
  if (process.env.HOST_WORK === "1") {
    new Worker("default", async () => {}, { connection })
  }
})()
