"use strict"

const { boot, grant, sleep, report } = require("./support")

async function main() {
  let rounds = 0
  let first = true
  const run = await boot({
    env: { DYNO: "web.1" },
    handler: (request) => {
      if (request.path === "/metrics/lease") {
        return grant(
          { trace: true, job_queues: [{ name: "worker", strategy: "jqs" }] },
          3600,
        )
      }
      if (first) {
        first = false
        return { status: 200, delay: 1500 }
      }
      return { status: 200 }
    },
    configure: (config) =>
      config.dyno("worker", () => {
        rounds += 1
        return 3
      }),
  })
  await sleep(6000)
  const ingests = run.ingests().map((request) => JSON.parse(request.body))
  const withTrace = ingests.filter((payload) =>
    payload.some((entry) => "sample_trace" in entry),
  ).length
  const withSample = ingests.filter((payload) =>
    payload.some((entry) => entry.metrics && entry.metrics.jqs),
  ).length
  await run.stop()
  report(
    "FINDING",
    "the trace of a sample round that ends while a dispatch waits for its response is never sent",
    rounds === 1 && withSample >= 1 && withTrace === 0,
    [
      `sample rounds: ${rounds}`,
      `ingest requests: ${ingests.length}, with the jqs sample: ${withSample}, with a sample_trace: ${withTrace}`,
    ],
  )
}

main()
