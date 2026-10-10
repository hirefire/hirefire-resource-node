const cluster = require("cluster")
const { Worker, isMainThread, workerData } = require("worker_threads")
const HireFire = require("../../../src")

const mode = process.argv[2]
const force = process.argv.includes("force")

function running() {
  return Boolean(HireFire.configuration._dispatcher?.running())
}

function boot(forceStart) {
  HireFire.configure((config) => {
    config.logger = null
    config.forceStart = forceStart
  })
}

function say(role, moment) {
  console.log(`${role} ${moment} ${running()}`)
}

if (!isMainThread) {
  boot(workerData.force)
  say("thread", "booted")
  HireFire.reset()
} else if (cluster.isWorker) {
  boot(false)
  say("worker", "booted")
  HireFire.reset().then(() => process.exit(0))
} else if (mode === "cluster") {
  boot(force)
  say("primary", "booted")
  cluster.fork().on("exit", () => {
    say("primary", "forked")
    boot(force)
    say("primary", "alone")
    HireFire.reset()
  })
} else {
  boot(false)
  say("main", "booted")
  new Worker(__filename, { workerData: { force } }).on("exit", () => {
    say("main", "threaded")
    HireFire.reset()
  })
}
