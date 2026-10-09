"use strict"

const { boot, grant, sleep, report } = require("./support")

async function main() {
  let hang = false
  let calls = 0
  const run = await boot({
    handler: (request) =>
      request.path === "/metrics/lease"
        ? grant({ job_queues: [{ name: "worker", strategy: "jqs" }] }, 1)
        : { status: 200 },
    configure: (config) =>
      config.dyno("worker", () => {
        calls += 1
        if (calls === 2)
          return new Promise((resolve) => setTimeout(() => resolve(1), 12000))
        if (hang) return new Promise(() => {})
        return 1
      }),
  })
  await sleep(18000)
  const times = run.leases().map((request) => request.at)
  const gaps = []
  for (let index = 1; index < times.length; index += 1) {
    gaps.push(Math.round((times[index] - times[index - 1]) / 100) / 10)
  }
  hang = true
  const before = run.leases().length
  await sleep(25000)
  const during = run.leases().length - before
  const running = run.HireFire.configuration.dispatcher.running()
  await run.stop()
  report(
    "FINDING",
    "the lease is not renewed while a sample runs: a 12 second sample leaves a 12 second gap against a 5 second TTL, and a sample that never returns ends the renewals for good",
    Math.max(...gaps) >= 11 && during <= 1 && running,
    [
      `seconds between lease requests with one sample of 12 seconds: ${gaps.join(
        ", ",
      )}`,
      `lease requests in the 25 seconds after a sample hung: ${during}`,
      `dispatcher reports running: ${running}`,
    ],
  )
}

main()
