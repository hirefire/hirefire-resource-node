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

  test("the round hooks of every adapter run before and after the body, and the after hook gets what the before hook returned", async () => {
    const events = []
    const macro = (name, token) => ({
      beforeSampleJobQueues: async () => {
        events.push(`before ${name}`)
        return token
      },
      afterSampleJobQueues: async (received) => {
        events.push(`after ${name} ${received}`)
      },
    })
    replaceAdapters({
      a: planAdapter(macro("a", "token")),
      b: planAdapter(macro("b", null)),
      c: planAdapter({}),
    })
    const lines = capture()

    const result = await Plan.aroundJobQueueSample(
      HireFire.configuration.logger,
      async () => {
        events.push("body")
        return "result"
      },
    )

    expect(result).toBe("result")
    expect(events).toEqual([
      "before a",
      "before b",
      "body",
      "after a token",
      "after b null",
    ])
    expect(lines).toEqual([])
  })

  test("the after hooks run when the body throws", async () => {
    const afterSampleJobQueues = jest.fn()
    replaceAdapters({
      a: planAdapter({
        beforeSampleJobQueues: () => "token",
        afterSampleJobQueues,
      }),
    })

    await expect(
      Plan.aroundJobQueueSample(HireFire.configuration.logger, async () => {
        throw new Error("body boom")
      }),
    ).rejects.toThrow("body boom")

    expect(afterSampleJobQueues.mock.calls).toEqual([["token"]])
  })

  test("a round hook that throws is logged and the other hooks and the body still run", async () => {
    const events = []
    replaceAdapters({
      a: planAdapter({
        beforeSampleJobQueues: () => {
          throw new Error("redis://user:secret@localhost:6379/0 before boom")
        },
        afterSampleJobQueues: () => events.push("after a"),
      }),
      b: planAdapter({
        beforeSampleJobQueues: () => events.push("before b"),
        afterSampleJobQueues: () => {
          throw "after boom"
        },
      }),
      c: planAdapter({
        beforeSampleJobQueues: () => events.push("before c"),
        afterSampleJobQueues: () => events.push("after c"),
      }),
    })
    const lines = capture()

    await Plan.aroundJobQueueSample(HireFire.configuration.logger, async () =>
      events.push("body"),
    )

    expect(events).toEqual(["before b", "before c", "body", "after c"])
    expect(lines).toEqual([
      [
        "error",
        '[HireFire] beforeSampleJobQueues for "a" raised Error: redis://***@localhost:6379/0 before boom',
      ],
      ["error", '[HireFire] afterSampleJobQueues for "b" raised after boom'],
    ])
  })
})
