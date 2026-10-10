const { Worker, isMainThread, workerData } = require("worker_threads")

if (isMainThread) {
  new Worker(__filename, { workerData: "app" })
} else {
  const HireFire = require("../../../src")
  HireFire.configure((config) => {
    config.logger = null
  })
  const running = Boolean(HireFire.configuration._dispatcher?.running())
  console.log(`${workerData} booted ${running}`)

  if (workerData === "app") {
    const host = require.resolve("../../../src/host")
    delete require.cache[host]
    console.log(`app loaded again ${require(host).startsAtBoot()}`)
    new Worker(__filename, { workerData: "helper" }).on("exit", () => {
      HireFire.reset()
    })
  } else {
    HireFire.reset()
  }
}
