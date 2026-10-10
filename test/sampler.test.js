const { capture, freezeTime, planAdapter } = require("./support")
const HireFire = require("../src")
const Configuration = require("../src/configuration")
const Plan = require("../src/plan")
const Sampler = require("../src/sampler")
const sampleRound = require("../src/sample_round")

describe("Sampler", () => {
  let lines

  beforeEach(() => {
    freezeTime(1000)
    lines = capture()
  })

  function config() {
    return HireFire.configuration
  }

  function local(name, strategy = "jql") {
    return { name, strategy }
  }

  function planned(name, fields = {}) {
    return {
      name,
      strategy: "jqs",
      adapter: "fake",
      queues: ["default"],
      ...fields,
    }
  }

  function samplePlan(plan, live = () => true) {
    return new Sampler(config()).round(plan, live)
  }

  function recorded(configuration = config()) {
    const data = configuration.buffer.flush()
    const values = {}
    for (const [name, strategies] of Object.entries(data)) {
      values[name] = {}
      for (const [strategy, series] of Object.entries(strategies)) {
        values[name][strategy] = Object.values(series)[0]
      }
    }
    return values
  }

  function messages(level) {
    return lines.filter(([at]) => at === level).map(([, message]) => message)
  }

  test("a local entry is sampled by the sampler of that name", async () => {
    config().dyno("worker", () => 42)
    config().dyno("mailer", async () => 18)

    await samplePlan([local("worker", "jql"), local("mailer", "jqs")])

    expect(recorded()).toEqual({ worker: { jql: 42 }, mailer: { jqs: 18 } })
    expect(lines).toEqual([])
  })

  test("a local entry is reported under the name the plan spells", async () => {
    config().dyno("Worker", () => 4)

    await samplePlan([local("worker", "jqs")])

    expect(recorded()).toEqual({ worker: { jqs: 4 } })
  })

  test("the latest sample of a second wins", async () => {
    const values = [5, 9]
    config().dyno("worker", () => values.shift())

    await samplePlan([local("worker")])
    await samplePlan([local("worker")])

    expect(recorded()).toEqual({ worker: { jql: 9 } })
  })

  test("zero and fractions are recorded as they are", async () => {
    config().dyno("zero", () => 0)
    config().dyno("fraction", () => 1.5)

    await samplePlan([local("zero"), local("fraction")])

    expect(recorded()).toEqual({ zero: { jql: 0 }, fraction: { jql: 1.5 } })
  })

  test("a long rejected value is cut at 64 bytes in the log", async () => {
    const values = ["a".repeat(64), "x" + "b".repeat(64)]
    config().dyno("worker", () => values.shift())

    await samplePlan([local("worker")])
    await samplePlan([local("worker")])

    expect(messages("error")).toEqual([
      `[HireFire] The sampler for "worker" returned string("${"a".repeat(
        64,
      )}"), expected a non-negative number. Sample dropped.`,
      `[HireFire] The sampler for "worker" returned string("x${"b".repeat(
        63,
      )}…"), expected a non-negative number. Sample dropped.`,
    ])
  })

  test("a value that is not a number from zero up is dropped and named in the log", async () => {
    const values = ["10", null, -1, Infinity, NaN, true, undefined, 5n]
    const count = values.length
    config().dyno("worker", () => values.shift())

    for (let i = 0; i < count; i++) await samplePlan([local("worker")])

    expect(recorded()).toEqual({})
    expect(messages("error")).toEqual(
      [
        'string("10")',
        'null("null")',
        'number("-1")',
        'number("Infinity")',
        'number("NaN")',
        'boolean("true")',
        'undefined("undefined")',
        'bigint("5")',
      ].map(
        (value) =>
          `[HireFire] The sampler for "worker" returned ${value}, expected a non-negative number. Sample dropped.`,
      ),
    )
  })

  test("a value whose text cannot be read is named by its type", async () => {
    config().dyno("worker", () => ({
      toString() {
        throw new Error("no text")
      },
    }))

    await samplePlan([local("worker")])

    expect(messages("error")).toEqual([
      '[HireFire] The sampler for "worker" returned object, expected a non-negative number. Sample dropped.',
    ])
  })

  test("a sampler that throws is logged without its credentials and the next entry is sampled", async () => {
    config().dyno("Worker", () => {
      throw new Error("redis://user:secret@localhost:6379/0 down")
    })
    config().dyno("clock", async () => {
      throw "Redis down"
    })
    config().dyno("mailer", () => 18)

    await samplePlan([local("worker"), local("clock"), local("mailer")])

    expect(recorded()).toEqual({ mailer: { jql: 18 } })
    expect(messages("error")).toEqual([
      '[HireFire] The sampler for "worker" raised Error: redis://***@localhost:6379/0 down',
      '[HireFire] The sampler for "clock" raised Redis down',
    ])
  })

  test("an adapter that cannot be asked is logged and the next entry is sampled", async () => {
    Plan.ADAPTERS.broken = planAdapter({ jobQueueSize: async () => 1 })
    Plan.ADAPTERS.broken.libraryLoaded = () => {
      throw new TypeError("redis://user:secret@localhost:6379/0 hook boom")
    }
    Plan.ADAPTERS.fake = planAdapter({ jobQueueSize: async () => 7 })

    const trace = await samplePlan([
      planned("worker", { adapter: "broken" }),
      planned("mailer"),
    ])

    expect(trace.ops).toHaveLength(2)
    expect(recorded()).toEqual({ mailer: { jqs: 7 } })
    expect(messages("error")).toEqual([
      '[HireFire] Plan sampler for "worker" raised TypeError: redis://***@localhost:6379/0 hook boom',
    ])
  })

  test("a logger that throws does not end the round", async () => {
    config().dyno("worker", () => {
      throw new Error("Redis down")
    })
    config().dyno("mailer", () => 18)
    config().logger = {
      error() {
        throw new Error("closed stream")
      },
    }

    await samplePlan([local("worker"), local("mailer")])

    expect(recorded()).toEqual({ mailer: { jql: 18 } })
  })

  test("a sample that returns after the round is no longer live is dropped", async () => {
    config().dyno("worker", () => 9)
    const live = [true, false]

    await samplePlan([local("worker")], () => live.shift())

    expect(recorded()).toEqual({})
    expect(lines).toEqual([])
  })

  test("a rejected value that returns after the round is no longer live is not logged", async () => {
    config().dyno("worker", () => "nope")
    const live = [true, false]

    await samplePlan([local("worker")], () => live.shift())

    expect(lines).toEqual([])
  })

  test("a round that is not live samples no entry", async () => {
    const sampler = jest.fn(() => 1)
    config().dyno("worker", sampler)

    const trace = await samplePlan([local("worker")], () => false)

    expect(sampler).not.toHaveBeenCalled()
    expect(trace.ops).toEqual([])
  })

  test("a round that stops being live samples no later entry", async () => {
    const mailer = jest.fn(() => 1)
    config().dyno("worker", () => 1)
    config().dyno("mailer", mailer)
    const live = [true, true, false]

    const trace = await samplePlan([local("worker"), local("mailer")], () =>
      live.shift(),
    )

    expect(mailer).not.toHaveBeenCalled()
    expect(trace.ops).toHaveLength(1)
    expect(recorded()).toEqual({ worker: { jql: 1 } })
  })

  test("samples go to the buffer of the configuration the sampler was given", async () => {
    const other = new Configuration()
    other.dyno("worker", () => 7)

    await new Sampler(other).round([local("worker")], () => true)

    expect(recorded()).toEqual({})
    expect(recorded(other)).toEqual({ worker: { jql: 7 } })
  })

  test("a local entry without a sampler of its name warns once when other samplers exist", async () => {
    config().dyno("worker", () => 1)
    const sampler = new Sampler(config())

    for (let i = 0; i < 3; i++) {
      await sampler.round([local("wroker"), local("worker")], () => true)
    }

    expect(lines).toEqual([
      [
        "warn",
        '[HireFire] No config.dyno sampler is named "wroker", so this process samples nothing for it. ' +
          "Check the name, or select an adapter for it in the HireFire UI.",
      ],
    ])
    expect(recorded()).toEqual({ worker: { jql: 1 } })
  })

  test("a local entry without a sampler is silent in a process that has no sampler at all", async () => {
    await samplePlan([local("worker")])

    expect(lines).toEqual([])
    expect(recorded()).toEqual({})
  })

  test("an entry with a problem is logged once per entry and never sampled", async () => {
    const sampler = new Sampler(config())
    const plan = [
      planned("worker", { adapter: "nope" }),
      planned("mailer", { adapter: "nope" }),
      planned("worker", { adapter: "other" }),
      local("worker", "rpm"),
    ]

    for (let i = 0; i < 3; i++) await sampler.round(plan, () => true)

    expect(lines).toEqual([
      [
        "error",
        '[HireFire] Unknown plan adapter "nope" for "worker". Entry skipped.',
      ],
      [
        "error",
        '[HireFire] Unknown plan adapter "nope" for "mailer". Entry skipped.',
      ],
      [
        "error",
        '[HireFire] Unknown plan adapter "other" for "worker". Entry skipped.',
      ],
      [
        "error",
        '[HireFire] Unknown plan strategy "rpm" for "worker". Entry skipped.',
      ],
    ])
    expect(recorded()).toEqual({})
  })

  test("an entry with a problem does not fall back to the local sampler of its name", async () => {
    const sampler = jest.fn(() => 1)
    config().dyno("worker", sampler)
    Plan.ADAPTERS.fake = planAdapter(
      { jobQueueSize: async () => 5 },
      { packages: ["hirefire-no-such-package"] },
    )

    await samplePlan([
      planned("worker"),
      planned("worker", { adapter: "nope" }),
    ])

    expect(sampler).not.toHaveBeenCalled()
    expect(recorded()).toEqual({})
    expect(messages("error")).toEqual([
      '[HireFire] Plan adapter "fake" for "worker" is not loaded in this process. Entry skipped.',
      '[HireFire] Unknown plan adapter "nope" for "worker". Entry skipped.',
    ])
  })

  test("a new sampler logs a problem again", async () => {
    await samplePlan([planned("worker", { adapter: "nope" })])
    await samplePlan([planned("worker", { adapter: "nope" })])

    expect(messages("error")).toHaveLength(2)
  })

  test("an adapter entry records its strategy and the running jobs when they apply", async () => {
    Plan.ADAPTERS.fake = planAdapter({
      jobQueueSize: async () => 11,
      jobQueueLatency: async () => 2.5,
      jobQueueWorking: async () => 3,
    })

    await samplePlan([
      planned("size"),
      planned("waiting", { options: { skip_working: true } }),
      planned("latency", { strategy: "jql" }),
    ])

    expect(recorded()).toEqual({
      size: { jqs: 11 },
      waiting: { jqs: 11, wrk: 3 },
      latency: { jql: 2.5, wrk: 3 },
    })
    expect(lines).toEqual([])
  })

  test("an adapter without a count of running jobs records its strategy alone", async () => {
    Plan.ADAPTERS.fake = planAdapter({ jobQueueLatency: async () => 2.5 })

    await samplePlan([planned("worker", { strategy: "jql" })])

    expect(recorded()).toEqual({ worker: { jql: 2.5 } })
    expect(lines).toEqual([])
  })

  test("an adapter that throws or returns no number is logged and the running jobs are still recorded", async () => {
    Plan.ADAPTERS.fake = planAdapter({
      jobQueueLatency: async () => {
        throw new RangeError("redis://user:secret@localhost:6379/0 refused")
      },
      jobQueueWorking: async () => 4,
    })
    Plan.ADAPTERS.other = planAdapter({
      jobQueueLatency: async () => "many",
      jobQueueWorking: async () => {
        throw new Error("working boom")
      },
    })
    Plan.ADAPTERS.third = planAdapter({
      jobQueueSize: async () => 6,
      jobQueueWorking: async () => -1,
    })

    await samplePlan([
      planned("worker", { strategy: "jql" }),
      planned("mailer", { strategy: "jql", adapter: "other" }),
      planned("clock", { adapter: "third", options: { skip_working: true } }),
    ])

    expect(recorded()).toEqual({ worker: { wrk: 4 }, clock: { jqs: 6 } })
    expect(messages("error")).toEqual([
      '[HireFire] Plan sampler for "worker" raised RangeError: redis://***@localhost:6379/0 refused',
      '[HireFire] Plan sampler for "mailer" returned string("many"), expected a non-negative number. Sample dropped.',
      '[HireFire] Plan working sampler for "mailer" raised Error: working boom',
      '[HireFire] Plan working sampler for "clock" returned number("-1"), expected a non-negative number. Sample dropped.',
    ])
  })

  test("the running jobs that return after the round is no longer live are dropped", async () => {
    Plan.ADAPTERS.fake = planAdapter({
      jobQueueLatency: async () => 2.5,
      jobQueueWorking: async () => 3,
    })
    const live = [true, true, false]

    await samplePlan([planned("worker", { strategy: "jql" })], () =>
      live.shift(),
    )

    expect(recorded()).toEqual({ worker: { jql: 2.5 } })
  })

  test("an adapter entry wins over a local sampler of the same name and says so once", async () => {
    const local = jest.fn(() => 1)
    config().dyno("Worker", local)
    Plan.ADAPTERS.fake = planAdapter({ jobQueueSize: async () => 11 })
    const sampler = new Sampler(config())

    await sampler.round([planned("worker")], () => true)
    await sampler.round([planned("worker")], () => true)

    expect(local).not.toHaveBeenCalled()
    expect(recorded()).toEqual({ worker: { jqs: 11 } })
    expect(lines).toEqual([
      [
        "warn",
        '[HireFire] A HireFire UI adapter is configured for "worker", so config.dyno("worker") ' +
          "with a local sampler is ignored. You can remove that local configuration. " +
          "The UI adapter is used instead.",
      ],
    ])
  })

  test("a queue list over the limit is cut and logged once with the name of the entry", async () => {
    const jobQueueSize = jest.fn(async () => 1)
    Plan.ADAPTERS.fake = planAdapter({ jobQueueSize })
    const sampler = new Sampler(config())
    const queues = Array.from({ length: 70 }, (_, index) => `q${index}`)

    await sampler.round([planned("worker", { queues })], () => true)
    await sampler.round([planned("worker", { queues })], () => true)

    expect(jobQueueSize.mock.calls.map((call) => call.length)).toEqual([65, 65])
    expect(lines).toEqual([
      [
        "error",
        '[HireFire] Plan queue list for "worker" truncated to 64 names.',
      ],
    ])
  })

  test("the round returns one timed operation per entry it reached", async () => {
    config().dyno("worker", () => 1)

    const trace = await samplePlan([
      local("worker"),
      planned("mailer", { adapter: "nope", options: { a: 1 } }),
    ])

    expect(typeof trace.wave_ms).toBe("number")
    expect(trace.ops).toEqual([
      { adapter: null, strategy: "jql", queues: [], options: {}, ms: 0 },
      {
        adapter: "nope",
        strategy: "jqs",
        queues: ["default"],
        options: { a: 1 },
        ms: 0,
      },
    ])
  })

  test("the round logs its timings when verbose is set", async () => {
    config().dyno("worker", () => 1)

    await samplePlan([local("worker")])
    expect(lines).toEqual([])

    process.env.HIREFIRE_VERBOSE = "1"
    await samplePlan([local("worker")])

    expect(messages("info")).toEqual([
      "[HireFire] sample_job_queues wave_ms=0 ops=1",
      "[HireFire] sample adapter=null strategy=jql queues= ms=0",
    ])
  })

  test("a process can sample a plan when it has a sampler or can run one of the entries", () => {
    const sampler = new Sampler(config())

    expect(sampler.canSample([])).toBe(false)
    expect(sampler.canSample([local("worker")])).toBe(false)
    expect(sampler.canSample([planned("worker", { adapter: "nope" })])).toBe(
      false,
    )

    Plan.ADAPTERS.fake = planAdapter({ jobQueueSize: async () => 1 })
    expect(
      sampler.canSample([
        planned("worker", { adapter: "nope" }),
        planned("mailer"),
      ]),
    ).toBe(true)
    expect(sampler.canSample([planned("mailer", { strategy: "rpm" })])).toBe(
      false,
    )

    config().dyno("worker", () => 1)
    expect(sampler.canSample([])).toBe(true)
    expect(sampler.canSample([planned("worker", { adapter: "nope" })])).toBe(
      true,
    )
  })

  test("the samplers of a round share one store, and the next round gets a new one", async () => {
    const stores = []
    config().dyno("worker", () => stores.push(sampleRound.getStore()))
    config().dyno("mailer", () => stores.push(sampleRound.getStore()))

    await samplePlan([local("worker"), local("mailer")])
    await samplePlan([local("worker")])

    expect(stores).toHaveLength(3)
    expect(stores[0]).toBeInstanceOf(Map)
    expect(stores[1]).toBe(stores[0])
    expect(stores[2]).toBeInstanceOf(Map)
    expect(stores[2]).not.toBe(stores[0])
    expect(sampleRound.getStore()).toBeUndefined()
  })
})
