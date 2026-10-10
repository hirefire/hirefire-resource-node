const { planAdapter } = require("../support")
const Plan = require("../../src/plan")
const Entry = require("../../src/plan/entry")

describe("Plan entry", () => {
  function entry(fields = {}) {
    return new Entry({
      name: "worker",
      strategy: "jqs",
      adapter: "fake",
      queues: ["default"],
      ...fields,
    })
  }

  function loaded(macro = {}, fields = {}) {
    return planAdapter(
      {
        jobQueueSize: async () => 5,
        jobQueueLatency: async () => 1.5,
        ...macro,
      },
      fields,
    )
  }

  test("an entry without an adapter is local and never sampleable by an adapter", () => {
    for (const adapter of [undefined, null, ""]) {
      const local = entry({ adapter })

      expect(local.local).toBe(true)
      expect(local.sampleable).toBe(false)
      expect(local.problem).toBeNull()
    }
    expect(entry().local).toBe(false)
  })

  test("a local entry with a strategy other than latency or size is a problem", () => {
    const local = entry({ adapter: null, strategy: "rpm" })

    expect(local.problem).toBe("unknown_strategy")
    expect(local.problemMessage).toBe(
      'Unknown plan strategy "rpm" for "worker". Entry skipped.',
    )
    expect(entry({ adapter: null, strategy: "toString" }).problem).toBe(
      "unknown_strategy",
    )
    expect(entry({ adapter: null, strategy: "jql" }).problem).toBeNull()
  })

  test("an adapter the client does not know is a problem", () => {
    const unknown = entry({ adapter: "nope" })

    expect(unknown.problem).toBe("unknown_adapter")
    expect(unknown.problemMessage).toBe(
      'Unknown plan adapter "nope" for "worker". Entry skipped.',
    )
    expect(unknown.sampleable).toBe(false)
    for (const name of ["constructor", "toString", "valueOf", "__proto__"]) {
      expect(entry({ adapter: name }).problem).toBe("unknown_adapter")
    }
  })

  test("an adapter whose library is not loaded is a problem", () => {
    Plan.ADAPTERS.fake = loaded({}, { packages: ["hirefire-no-such-package"] })

    expect(entry().problem).toBe("unloaded_adapter")
    expect(entry().problemMessage).toBe(
      'Plan adapter "fake" for "worker" is not loaded in this process. Entry skipped.',
    )
    expect(entry().sampleable).toBe(false)
  })

  test("a strategy the adapter does not take is a problem", () => {
    Plan.ADAPTERS.fake = loaded()
    Plan.ADAPTERS.sized = loaded({}, { strategies: ["jqs"] })

    expect(entry({ strategy: "rpm" }).problem).toBe("unsupported_strategy")
    expect(entry({ adapter: "sized", strategy: "jql" }).problem).toBe(
      "unsupported_strategy",
    )
    expect(entry({ adapter: "sized", strategy: "jql" }).problemMessage).toBe(
      'Plan adapter "sized" does not support strategy "jql" for "worker". Entry skipped.',
    )
    expect(entry({ adapter: "sized", strategy: "jqs" }).problem).toBeNull()
    expect(entry({ strategy: "jql" }).problem).toBeNull()
  })

  test("a queue list that is not a list or holds no valid name is a problem", () => {
    Plan.ADAPTERS.fake = loaded()

    expect(entry({ queues: "default" }).problem).toBe("queues_not_a_list")
    expect(entry({ queues: "default" }).problemMessage).toBe(
      'Plan queues for "worker" must be an array. Entry skipped.',
    )
    expect(entry({ queues: { a: 1 } }).problem).toBe("queues_not_a_list")
    expect(entry({ queues: 0 }).problem).toBe("queues_not_a_list")
    expect(entry({ queues: ["", "  ", "x".repeat(129)] }).problem).toBe(
      "no_valid_queues",
    )
    expect(entry({ queues: [""] }).problemMessage).toBe(
      'Plan queue list for "worker" had no valid names. Entry skipped.',
    )
    expect(entry({ queues: [null] }).problem).toBe("no_valid_queues")
    expect(entry({ queues: null }).problem).toBeNull()
    expect(entry({ queues: undefined }).problem).toBeNull()
    expect(entry({ queues: [] }).problem).toBeNull()
  })

  test("an entry without a problem is sampleable", () => {
    Plan.ADAPTERS.fake = loaded()

    expect(entry().sampleable).toBe(true)
    expect(entry({ queues: null }).sampleable).toBe(true)
  })

  test("queue names are stripped and limited in length and number", () => {
    expect(Plan.MAX_QUEUES).toBe(64)
    expect(Plan.MAX_QUEUE_NAME_BYTES).toBe(128)
    const names = [" default ", "", null, "x".repeat(128), "x".repeat(129), 7]
    const numbered = (count) =>
      Array.from({ length: count }, (_, index) => `q${index}`)

    expect(entry({ queues: names }).queues).toEqual([
      "default",
      "x".repeat(128),
      "7",
    ])
    expect(entry({ queues: names }).truncated).toBe(false)
    expect(entry({ queues: ["é".repeat(64), "é".repeat(65)] }).queues).toEqual([
      "é".repeat(64),
    ])

    const exact = entry({ queues: numbered(64) })
    const over = entry({ queues: numbered(65) })
    expect(exact.queues).toHaveLength(64)
    expect(exact.truncated).toBe(false)
    expect(over.queues).toEqual(numbered(64))
    expect(over.truncated).toBe(true)
  })

  test("the call passes the queues, the options the adapter allows, and its connection options", async () => {
    const jobQueueSize = jest.fn(async () => 9)
    Plan.ADAPTERS.fake = loaded(
      { jobQueueSize },
      { environment: { connection: "HIREFIRE_T_URL" } },
    )
    process.env.HIREFIRE_T_URL = "redis://127.0.0.1:6379/2"

    try {
      const result = await entry({
        queues: ["default", "mailer"],
        options: { skip_working: true, server: true },
      }).call()

      expect(result).toBe(9)
      expect(jobQueueSize.mock.calls).toEqual([
        [
          "default",
          "mailer",
          { skipWorking: true, connection: "redis://127.0.0.1:6379/2" },
        ],
      ])
    } finally {
      delete process.env.HIREFIRE_T_URL
    }
  })

  test("the call uses the latency method for a latency entry", async () => {
    Plan.ADAPTERS.fake = loaded()

    expect(await entry({ strategy: "jql" }).call()).toBe(1.5)
    expect(await entry({ strategy: "jqs" }).call()).toBe(5)
  })

  test("working is sampled for latency and for a size that leaves running jobs out", async () => {
    const jobQueueWorking = jest.fn(async () => 3)
    Plan.ADAPTERS.fake = loaded(
      { jobQueueWorking },
      { environment: { connection: "HIREFIRE_T_URL" } },
    )
    Plan.ADAPTERS.plain = loaded()
    process.env.HIREFIRE_T_URL = "redis://127.0.0.1:6379/2"

    try {
      expect(entry({ strategy: "jql" }).working).toBe(true)
      expect(entry({ options: { skip_working: true } }).working).toBe(true)
      expect(entry().working).toBe(false)
      expect(entry({ options: { skip_working: false } }).working).toBe(false)
      expect(entry({ adapter: "plain", strategy: "jql" }).working).toBe(false)
      expect(
        await entry({
          strategy: "jql",
          queues: ["default", "mailer"],
          options: { skip_working: true },
        }).callWorking(),
      ).toBe(3)
      expect(jobQueueWorking.mock.calls).toEqual([
        ["default", "mailer", { connection: "redis://127.0.0.1:6379/2" }],
      ])
    } finally {
      delete process.env.HIREFIRE_T_URL
    }
  })

  test("the key tells entries apart by name, adapter, and strategy", () => {
    expect(entry().key).toBe("worker\0fake\0jqs")
    expect(entry({ strategy: "jql" }).key).not.toBe(entry().key)
    expect(entry({ name: "mailer" }).key).not.toBe(entry().key)
    expect(entry({ adapter: null }).key).toBe("worker\0\0jqs")
  })
})
