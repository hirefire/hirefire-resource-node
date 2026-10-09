"use strict"

const { boot, sleep, report } = require("./support")

async function main() {
  const run = await boot({ env: { DYNO: "run.4821" } })
  await sleep(2500)
  const running = run.HireFire.configuration.dispatcher.running()
  const names = new Set()
  for (const request of run.ingests()) {
    for (const entry of JSON.parse(request.body)) names.add(entry.name)
  }
  await run.stop()
  report(
    "FINDING",
    "a Heroku one-off dyno (DYNO=run.4821) starts the dispatcher and reports under the name run",
    running && names.has("run"),
    [
      `dispatcher running: ${running}`,
      `names in ingest payloads: ${[...names].join(", ") || "none"}`,
      `log: ${run.log.join(" | ")}`,
    ],
  )
}

main()
