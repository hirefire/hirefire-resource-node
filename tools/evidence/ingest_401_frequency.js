"use strict"

const { boot, sleep, report } = require("./support")

async function main() {
  const run = await boot({
    env: { DYNO: "web.1" },
    handler: () => ({
      status: 401,
      headers: { "HireFire-Dispatch-Frequency": "30" },
    }),
  })
  await sleep(6500)
  const ingests = run.ingests().length
  const lines = run.log.filter((line) => !line.includes("Starting dispatcher"))
  await run.stop()
  report(
    "FINDING",
    "a 401 with HireFire-Dispatch-Frequency: 30 does not slow the client",
    ingests >= 5,
    [
      `ingest requests in 6.5 seconds: ${ingests} (one is due at 30 seconds)`,
      `log lines: ${lines.length}`,
    ],
  )
}

main()
