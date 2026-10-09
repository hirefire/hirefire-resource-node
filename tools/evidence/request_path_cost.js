"use strict"

const path = require("path")
const { boot, library, report } = require("./support")

function measure(fn, calls) {
  for (let index = 0; index < 20000; index += 1) fn()
  const started = process.hrtime.bigint()
  for (let index = 0; index < calls; index += 1) fn()
  return Number(process.hrtime.bigint() - started) / calls
}

async function main() {
  const run = await boot({ env: { DYNO: "web.1" } })
  const middleware = require(path.join(library, "src", "middleware", "connect"))
  const next = () => {}
  const bare = { headers: {} }
  const calls = 300000
  const results = []
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const request = { headers: { "x-request-start": String(Date.now() - 5) } }
    results.push({
      plain: Math.round(measure(() => next(), calls)),
      noHeader: Math.round(measure(() => middleware(bare, {}, next), calls)),
      sampled: Math.round(measure(() => middleware(request, {}, next), calls)),
    })
    run.HireFire.configuration.buffer.flush()
  }
  await run.stop()
  report(
    "CHECK",
    "one request through the middleware with a running dispatcher costs under 5 microseconds",
    results.every((result) => result.sampled < 5000),
    results.map(
      (result, index) =>
        `run ${index + 1}: bare call ${
          result.plain
        } ns, middleware without the header ${
          result.noHeader
        } ns, middleware with a sample ${result.sampled} ns`,
    ),
  )
}

main()
