"use strict"

const { boot, sleep, report } = require("./support")

async function main() {
  let created = 0
  const original = global.setTimeout
  global.setTimeout = function countedTimeout(...args) {
    created += 1
    return original.apply(this, args)
  }
  const sampler = process.argv[2] === "race"
  const run = await boot({
    env: { DYNO: "web.1" },
    configure: (config) => {
      if (sampler) config.dyno("worker", () => 1)
    },
  })
  await sleep(1000)
  const before = created
  await sleep(10000)
  const perSecond = (created - before - 1) / 10
  global.setTimeout = original
  await run.stop()
  report(
    "CHECK",
    `an idle web process ${
      sampler ? "in the lease race" : "outside the lease race"
    } creates a handful of timers per second, all unref'd`,
    perSecond <= 6,
    [
      `timers created per second: ${perSecond}`,
      `active resources that keep the process alive: ${
        process.getActiveResourcesInfo().filter((name) => name === "Timeout")
          .length
      } timers`,
    ],
  )
}

main()
