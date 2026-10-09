"use strict"

const { boot, grant, sleep, report } = require("./support")

async function main() {
  const entries = []
  for (let index = 0; index < 300; index += 1) {
    entries.push({ name: `queue-${index}`, strategy: "jqs" })
  }
  const run = await boot({
    handler: (request) =>
      request.path === "/metrics/lease"
        ? grant({ job_queues: entries }, 15)
        : { status: 200 },
    configure: (config) => config.dyno("queue-0", () => 1),
  })
  await sleep(600)
  await run.stop()
  const line = run.log.find((entry) => entry.includes("truncated")) || ""
  report(
    "FINDING",
    "a grant with 300 valid entries is logged as 44 invalid entries",
    line.includes("44 invalid also skipped"),
    [`log line: ${line}`],
  )
}

main()
