"use strict"

const { Worker, isMainThread, threadId } = require("worker_threads")
const HireFire = require("hirefire-resource")

HireFire.configure((config) => config.dyno("worker", () => 3))
console.log(
  `[host] pid=${
    process.pid
  } thread=${threadId} running=${HireFire.configuration.dispatcher.running()}`,
)
if (isMainThread) {
  new Worker(__filename)
  new Worker(__filename)
  setInterval(() => {}, 1000)
} else {
  setInterval(() => {}, 1000)
}
