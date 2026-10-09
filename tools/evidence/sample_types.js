"use strict"

const { boot, grant, sleep, report } = require("./support")

async function main() {
  const run = await boot({
    handler: (request) =>
      request.path === "/metrics/lease"
        ? grant(
            {
              job_queues: [
                { name: "text", strategy: "jqs" },
                { name: "big", strategy: "jqs" },
                { name: "missing", strategy: "jqs" },
                { name: "nothing", strategy: "jqs" },
                { name: "truth", strategy: "jqs" },
              ],
            },
            3600,
          )
        : { status: 200 },
    configure: (config) => {
      config.dyno("text", () => "5")
      config.dyno("big", () => 5n)
      config.dyno("missing", () => undefined)
      config.dyno("nothing", () => null)
      config.dyno("truth", () => true)
    },
  })
  await sleep(2500)
  const lines = run.log.filter((line) => line.includes("returned"))
  const sent = new Set()
  for (const request of run.ingests()) {
    for (const entry of JSON.parse(request.body)) sent.add(entry.name)
  }
  await run.stop()
  report(
    "CHECK",
    'a sampler that returns "5", 5n, undefined, null, or true is dropped with one error line each and sends nothing',
    lines.length === 5 && sent.size === 0,
    [...lines, `names sent: ${[...sent].join(", ") || "none"}`],
  )
}

main()
