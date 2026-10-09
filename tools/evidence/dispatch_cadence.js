"use strict"

const { boot, sleep, report } = require("./support")

async function main() {
  const seconds = Number(process.argv[2] || 60)
  const run = await boot({ env: { DYNO: "web.1" } })
  await sleep(seconds * 1000)
  const times = run.ingests().map((request) => request.at)
  await run.stop()
  const gaps = []
  for (let index = 1; index < times.length; index += 1) {
    gaps.push(times[index] - times[index - 1])
  }
  const sorted = [...gaps].sort((a, b) => a - b)
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length
  const long = gaps.filter((gap) => gap >= 1500).length
  report(
    "CHECK",
    "at a dispatch frequency of 1 second an idle web process dispatches once per second, with no interval of 1.5 seconds or more",
    times.length >= seconds - 1 && long === 0,
    [
      `ingest requests in ${seconds} seconds: ${times.length}`,
      `interval mean ${Math.round(mean)} ms, median ${
        sorted[Math.floor(sorted.length / 2)]
      } ms, shortest ${sorted[0]} ms, longest ${sorted[sorted.length - 1]} ms`,
      `intervals of 1.5 seconds or more: ${long} of ${gaps.length}`,
    ],
  )
}

main()
