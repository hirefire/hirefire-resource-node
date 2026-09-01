const bull = require("../src/macro/bull")
const bullmq = require("../src/macro/bullmq")
const pgBoss = require("../src/macro/pg_boss")
const { reset } = require("../src/macro/pg_boss_blocked_column")

describe("first-party adapter published surface", () => {
  test.each([
    ["bull", bull],
    ["bullmq", bullmq],
    ["pg_boss", pgBoss],
  ])("%s queuesRequired is a function that returns false", (_name, macro) => {
    expect(typeof macro.queuesRequired).toBe("function")
    expect(macro.queuesRequired()).toBe(false)
  })

  test("pg-boss published export omits the blocked-column test reset", () => {
    expect(pgBoss).not.toHaveProperty("_resetBlockedColumnCacheForTests")
    expect(Object.keys(pgBoss)).not.toContain("reset")
  })

  test("blocked-column reset still clears the shared cache", () => {
    const cache = require("../src/macro/pg_boss_blocked_column")
    cache.present.add("schema\0url")
    cache.absentUntil.set("schema\0url", Date.now() + 60_000)
    reset()
    expect(cache.present.size).toBe(0)
    expect(cache.absentUntil.size).toBe(0)
  })
})
