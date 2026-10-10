const cluster = require("cluster")
const HireFire = require("./hirefire")
const VERSION = require("./version")

const key = Symbol.for(`hirefire-resource@${VERSION}`)

if (!globalThis[key]) {
  const instance = new HireFire()
  cluster.on("fork", () => instance._handOver())
  globalThis[key] = instance
}

module.exports = globalThis[key]
