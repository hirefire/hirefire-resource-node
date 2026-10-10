const { capture, planAdapter } = require("../support")
const HireFire = require("../../src")
const Plan = require("../../src/plan")

describe("Plan", () => {
  function replaceAdapters(adapters) {
    for (const name of Object.keys(Plan.ADAPTERS)) delete Plan.ADAPTERS[name]
    Object.assign(Plan.ADAPTERS, adapters)
  }

  test("the adapters with their packages, their strategies, and their variables", () => {
    const table = Object.fromEntries(
      Object.entries(Plan.ADAPTERS).map(([name, adapter]) => [
        name,
        [adapter.packages, adapter.strategies, adapter.environment],
      ]),
    )

    expect(table).toEqual({
      bull: [["bull", "ioredis"], ["jqs"], { connection: "HIREFIRE_BULL_URL" }],
      bullmq: [
        ["bullmq", "ioredis"],
        ["jqs"],
        { connection: "HIREFIRE_BULLMQ_URL" },
      ],
      pg_boss: [
        ["pg-boss", "pg"],
        ["jql", "jqs"],
        {
          connection: "HIREFIRE_PG_BOSS_URL",
          schema: "HIREFIRE_PG_BOSS_SCHEMA",
        },
      ],
    })
  })

  test("every planned adapter takes the strategies and options the server sends", () => {
    const sizeOnly = ["bull", "bullmq"]

    for (const [name, adapter] of Object.entries(Plan.ADAPTERS)) {
      expect(adapter.supports("jqs")).toBe(true)
      expect(adapter.supports("jql")).toBe(!sizeOnly.includes(name))
      expect(typeof adapter.macro.jobQueueSize).toBe("function")
      expect(typeof adapter.macro.jobQueueLatency).toBe("function")
      expect(typeof adapter.macro.jobQueueWorking).toBe("function")
      expect(adapter.options("jqs", { skip_working: true })).toEqual({
        skipWorking: true,
      })
      expect(adapter.options("jqs", {})).toEqual({})
      expect(adapter.options("jql", { skip_working: true })).toEqual({})
    }
  })

  test("adapter returns the row of a known name and null for every other name", () => {
    expect(Plan.adapter("bullmq")).toBe(Plan.ADAPTERS.bullmq)
    expect(Plan.adapter("pg_boss")).toBe(Plan.ADAPTERS.pg_boss)
    for (const name of [
      "sidekiq",
      "",
      "constructor",
      "toString",
      "valueOf",
      "__proto__",
    ]) {
      expect(Plan.adapter(name)).toBeNull()
    }
  })

  test("a library counts as loaded when one adapter has its packages", () => {
    const absent = { packages: ["hirefire-no-such-package"] }

    replaceAdapters({})
    expect(Plan.anyLibraryLoaded()).toBe(false)

    replaceAdapters({ a: planAdapter({}, absent), b: planAdapter({}, absent) })
    expect(Plan.anyLibraryLoaded()).toBe(false)

    replaceAdapters({ a: planAdapter({}, absent), b: planAdapter({}) })
    expect(Plan.anyLibraryLoaded()).toBe(true)
  })
})
