"use strict"

const { boot, sleep, report } = require("./support")

async function main() {
  let samples = 0
  const run = await boot({
    handler: (request) =>
      request.path === "/metrics/lease"
        ? {
            status: 200,
            headers: {
              "HireFire-Lease-Granted": "true",
              "HireFire-Lease-TTL": "abc",
              "HireFire-Sample-Frequency": "soon",
            },
            body: JSON.stringify({
              job_queues: [{ name: "worker", strategy: "jqs" }],
            }),
          }
        : { status: 200 },
    configure: (config) =>
      config.dyno("worker", () => {
        samples += 1
        return 1
      }),
  })
  await sleep(6500)
  const leases = run.leases().length
  await run.stop()
  report(
    "FINDING",
    'a sample frequency of "soon" and a TTL of "abc" become 1 and 5 seconds, where the defaults are 15 and 15',
    samples >= 5 && leases >= 2,
    [
      `sampler calls in 6.5 seconds: ${samples} (one is due at the default of 15 seconds)`,
      `lease requests in 6.5 seconds: ${leases} (one is due at the default of 15 seconds)`,
    ],
  )
}

main()
