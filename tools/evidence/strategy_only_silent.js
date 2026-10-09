"use strict"

const { boot, grant, sleep, report } = require("./support")

async function main() {
  let calls = 0
  const run = await boot({
    env: { HIREFIRE_SERVICE_NAME: "worker" },
    handler: (request) =>
      request.path === "/metrics/lease"
        ? grant({ job_queues: [{ name: "wroker", strategy: "jqs" }] }, 1)
        : { status: 200 },
    configure: (config) =>
      config.dyno("worker", () => {
        calls += 1
        return 1
      }),
  })
  await sleep(3500)
  const lines = run.log.filter((line) => !line.includes("Starting dispatcher"))
  await run.stop()
  report(
    "FINDING",
    "a plan entry whose name matches no local sampler is skipped without a log line",
    calls === 0 && lines.length === 0,
    [`sampler calls: ${calls}`, `log lines: ${lines.join(" | ") || "none"}`],
  )
}

main()
