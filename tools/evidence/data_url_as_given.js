"use strict"

const { boot, sleep, report } = require("./support")

async function main() {
  const run = await boot({ env: { DYNO: "web.1" } })
  process.env.HIREFIRE_DATA_URL = "http://nonexistent-host.invalid"
  await sleep(2500)
  const insecure = run.log.filter((line) => line.startsWith("W"))
  const before = run.log.length
  process.env.HIREFIRE_DATA_URL = "data.example.invalid"
  await sleep(2500)
  const invalid = run.log.slice(before)
  process.env.HIREFIRE_DATA_URL = run.server.url
  await run.stop()
  report(
    "FINDING",
    "an http URL on a remote host gets no warning, and a value without a scheme fails without naming the variable",
    insecure.length === 0 &&
      invalid.length > 0 &&
      invalid.every((line) => !line.includes("HIREFIRE_DATA_URL")),
    [
      `warnings for http://nonexistent-host.invalid: ${insecure.length}`,
      `lines for data.example.invalid: ${[...new Set(invalid)].join(" | ")}`,
    ],
  )
}

main()
