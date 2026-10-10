"use strict"

const { threadId } = require("worker_threads")
const HireFire = require("hirefire-resource")

HireFire.configure((config) => config.dyno("worker", () => 3))
console.log(
  `[host] pid=${
    process.pid
  } thread=${threadId} running=${HireFire.configuration.dispatcher.running()}`,
)
const work = setInterval(() => {}, 1000)

module.exports = { close: () => clearInterval(work) }
