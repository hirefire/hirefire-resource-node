"use strict"

const { boot, sleep, report, library } = require("./support")
const path = require("path")

async function main() {
  const run = await boot({ env: { DYNO: "web.1" } })
  const middleware = require(path.join(library, "src", "middleware", "connect"))
  await sleep(1200)
  await run.HireFire.configuration.dispatcher.stop()
  const stopped = !run.HireFire.configuration.dispatcher.running()
  const before = run.ingests().length
  middleware(
    { headers: { "x-request-start": String(Date.now() - 5) } },
    {},
    () => {},
  )
  const restarted = run.HireFire.configuration.dispatcher.running()
  await sleep(1500)
  const after = run.ingests().length
  await run.stop()
  report(
    "FINDING",
    "a request that arrives after the host stopped the dispatcher starts it again",
    stopped && restarted && after > before,
    [
      `running after stop: ${!stopped}`,
      `running after one request: ${restarted}`,
      `ingest requests after the stop: ${after - before}`,
      `starts logged: ${
        run.log.filter((line) => line.includes("Starting dispatcher")).length
      }`,
    ],
  )
}

main()
