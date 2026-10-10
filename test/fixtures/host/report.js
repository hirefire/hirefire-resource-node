const cluster = require("cluster")
const { Worker, isMainThread, workerData } = require("worker_threads")
const HireFire = require("../../../src")
const { processRequestQueueTime } = require("../../../src/middleware")

const mode = process.argv[2]
const serves = process.argv.includes("serves")

function running() {
  return Boolean(HireFire.configuration._dispatcher?.running())
}

function boot() {
  HireFire.configure((config) => {
    config.logger = null
  })
}

function say(role, moment) {
  console.log(`${role} ${moment} ${running()}`)
}

function serve(role) {
  processRequestQueueTime(String(Date.now()))
  say(role, "served")
}

if (!isMainThread) {
  boot()
  say("thread", "booted")
  if (workerData.serves) serve("thread")
  HireFire.reset()
} else if (cluster.isWorker) {
  boot()
  say("worker", "booted")
  HireFire.reset().then(() => process.exit(0))
} else if (mode === "cluster") {
  boot()
  say("primary", "booted")
  if (serves) serve("primary")
  cluster.fork().on("exit", () => {
    say("primary", "forked")
    boot()
    say("primary", "alone")
    HireFire.reset()
  })
} else {
  boot()
  say("main", "booted")
  new Worker(__filename, { workerData: { serves } }).on("exit", () => {
    say("main", "threaded")
    HireFire.reset()
  })
}
