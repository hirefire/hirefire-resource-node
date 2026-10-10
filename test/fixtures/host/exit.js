const HireFire = require("../../../src")
const { processRequestQueueTime } = require("../../../src/middleware")

HireFire.configure((config) => {
  config.logger = null
  config.dyno("worker", () => 3)
})
processRequestQueueTime(String(Date.now()))
setTimeout(() => {}, 1500)
