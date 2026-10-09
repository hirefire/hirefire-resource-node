"use strict"

const HireFire = require("hirefire-resource")

HireFire.configure((config) => {
  if (process.env.HOST_SAMPLER === "1") config.dyno("worker", () => 3)
})
console.log(`[host] pid=${process.pid} configured, nothing else to do`)
