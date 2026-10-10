const bull = require("../src/macro/bull")
const bullmq = require("../src/macro/bullmq")
const pgBoss = require("../src/macro/pg_boss")
const { reset } = require("../src/macro/pg_boss/blocked_column")

describe("first-party adapter published surface", () => {
  test.each([
    ["bull", bull, ["JobQueueLatencyUnsupportedError"]],
    ["bullmq", bullmq, ["JobQueueLatencyUnsupportedError"]],
    ["pg_boss", pgBoss, []],
  ])("%s exports its three macros and no plan hook", (_name, macro, errors) => {
    expect(Object.keys(macro).sort()).toEqual(
      [...errors, "jobQueueLatency", "jobQueueSize", "jobQueueWorking"].sort(),
    )
  })

  test("pg-boss published export omits the blocked-column test reset", () => {
    expect(pgBoss).not.toHaveProperty("_resetBlockedColumnCacheForTests")
    expect(Object.keys(pgBoss)).not.toContain("reset")
  })

  test("blocked-column reset still clears the shared cache", () => {
    const cache = require("../src/macro/pg_boss/blocked_column")
    cache.present.add("schema\0url")
    cache.absentUntil.set("schema\0url", Date.now() + 60_000)
    reset()
    expect(cache.present.size).toBe(0)
    expect(cache.absentUntil.size).toBe(0)
  })
})
