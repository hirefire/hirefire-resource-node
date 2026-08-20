require("../support")
const Plan = require("../../src/plan")
const Configuration = require("../../src/configuration")

describe("Plan", () => {
  let configuration

  beforeEach(() => {
    configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }
  })

  test("known adapter and strategy", () => {
    expect(Plan.knownAdapter("bullmq")).toBe(true)
    expect(Plan.knownAdapter("bull")).toBe(true)
    expect(Plan.knownAdapter("pg_boss")).toBe(true)
    expect(Plan.knownAdapter("sidekiq")).toBe(false)
    expect(Plan.knownStrategy("jqs")).toBe(true)
    expect(Plan.knownStrategy("jql")).toBe(true)
  })

  test("supports strategy jqs only for bullmq", () => {
    expect(Plan.supportsStrategy("bullmq", "jqs")).toBe(true)
    expect(Plan.supportsStrategy("bullmq", "jql")).toBe(false)
  })

  test("supports strategy jqs only for bull", () => {
    expect(Plan.supportsStrategy("bull", "jqs")).toBe(true)
    expect(Plan.supportsStrategy("bull", "jql")).toBe(false)
  })

  test("supports strategy jql and jqs for pg_boss", () => {
    expect(Plan.supportsStrategy("pg_boss", "jqs")).toBe(true)
    expect(Plan.supportsStrategy("pg_boss", "jql")).toBe(true)
    expect(Plan.supportsStrategy("pg_boss", "rpm")).toBe(false)
  })

  test("libraryLoaded for pg_boss requires both pg-boss and pg", () => {
    const planModule = require.cache[require.resolve("../../src/plan")]
    const originalResolve = planModule.require.resolve
    const present = new Set(["pg-boss", "pg"])

    const mockResolve = function resolve(request, options) {
      if (request === "pg-boss" || request === "pg") {
        if (!present.has(request)) {
          const err = new Error(`Cannot find module '${request}'`)
          err.code = "MODULE_NOT_FOUND"
          throw err
        }
        return `/virtual-hirefire/${request}/index.js`
      }
      return originalResolve.call(planModule.require, request, options)
    }
    mockResolve.paths = originalResolve.paths
    planModule.require.resolve = mockResolve

    try {
      present.delete("pg")
      expect(Plan.libraryLoaded("pg_boss")).toBe(false)
      expect(Plan.executable("pg_boss")).toBe(false)

      present.add("pg")
      present.delete("pg-boss")
      expect(Plan.libraryLoaded("pg_boss")).toBe(false)
      expect(Plan.executable("pg_boss")).toBe(false)

      present.add("pg-boss")
      present.add("pg")
      expect(Plan.libraryLoaded("pg_boss")).toBe(true)
      expect(Plan.executable("pg_boss")).toBe(true)
    } finally {
      planModule.require.resolve = originalResolve
    }
  })

  test("libraryLoaded isolates bull from bullmq package names", () => {
    const planModule = require.cache[require.resolve("../../src/plan")]
    const originalResolve = planModule.require.resolve
    const present = new Set()

    const mockResolve = function resolve(request, options) {
      if (request === "bull" || request === "bullmq") {
        if (!present.has(request)) {
          const err = new Error(`Cannot find module '${request}'`)
          err.code = "MODULE_NOT_FOUND"
          throw err
        }
        return `/virtual-hirefire/${request}/index.js`
      }
      return originalResolve.call(planModule.require, request, options)
    }
    mockResolve.paths = originalResolve.paths
    planModule.require.resolve = mockResolve

    try {
      expect(Plan.libraryLoaded("bull")).toBe(false)
      expect(Plan.libraryLoaded("bullmq")).toBe(false)

      present.add("bullmq")
      expect(Plan.libraryLoaded("bullmq")).toBe(true)
      expect(Plan.libraryLoaded("bull")).toBe(false)
      expect(Plan.executable("bull")).toBe(false)

      present.delete("bullmq")
      present.add("bull")
      expect(Plan.libraryLoaded("bull")).toBe(true)
      expect(Plan.libraryLoaded("bullmq")).toBe(false)
      expect(Plan.executable("bullmq")).toBe(false)

      present.add("bullmq")
      expect(Plan.libraryLoaded("bull")).toBe(true)
      expect(Plan.libraryLoaded("bullmq")).toBe(true)
    } finally {
      planModule.require.resolve = originalResolve
    }
  })

  test("supports strategy rejects unknown adapter and strategy", () => {
    expect(Plan.supportsStrategy("unknown", "jql")).toBe(false)
    expect(Plan.supportsStrategy("bullmq", "rpm")).toBe(false)
    expect(Plan.supportsStrategy("bullmq", "unknown")).toBe(false)
  })

  test("execute skips jql bullmq", async () => {
    await Plan.execute(
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "jql",
        queues: ["default"],
      },
      configuration,
    )
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
    expect(configuration.logger.error).toHaveBeenCalled()
  })

  test("execute skips jql bull", async () => {
    await Plan.execute(
      {
        name: "worker",
        adapter: "bull",
        strategy: "jql",
        queues: ["default"],
      },
      configuration,
    )
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
    expect(configuration.logger.error).toHaveBeenCalled()
  })

  test("execute unknown adapter", async () => {
    await Plan.execute(
      {
        name: "worker",
        adapter: "nope",
        strategy: "jqs",
      },
      configuration,
    )
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown plan adapter"),
    )
  })

  test("normalize queues null becomes empty", async () => {
    const sample = jest.fn(async () => 1)
    const macro = require("../../src/macro/bullmq")
    const orig = macro.jobQueueSize
    macro.jobQueueSize = sample
    try {
      jest.spyOn(Plan, "executable").mockReturnValue(true)
      jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
      Object.defineProperty(Plan.ADAPTERS, "bullmq", {
        get: () => macro,
        configurable: true,
      })
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: null,
        },
        configuration,
      )
      expect(sample).toHaveBeenCalledWith({})
    } finally {
      macro.jobQueueSize = orig
    }
  })

  test('JSON null queue elements are dropped (not the name "null")', async () => {
    const sample = jest.fn(async () => 1)
    const macro = require("../../src/macro/bullmq")
    const orig = macro.jobQueueSize
    macro.jobQueueSize = sample
    try {
      jest.spyOn(Plan, "executable").mockReturnValue(true)
      jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
      Object.defineProperty(Plan.ADAPTERS, "bullmq", {
        get: () => macro,
        configurable: true,
      })
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: [null, "default", undefined, null],
        },
        configuration,
      )
      expect(sample).toHaveBeenCalledWith("default", {})
      expect(sample.mock.calls[0].some((a) => a === "null")).toBe(false)

      sample.mockClear()
      configuration.logger.error.mockClear()
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: [null, null],
        },
        configuration,
      )
      expect(sample).not.toHaveBeenCalled()
      expect(configuration.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("had no valid names"),
      )
    } finally {
      macro.jobQueueSize = orig
    }
  })

  test("invalid sample dropped", async () => {
    const macro = require("../../src/macro/bullmq")
    const orig = macro.jobQueueSize
    macro.jobQueueSize = async () => -1
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
    } finally {
      macro.jobQueueSize = orig
    }
  })

  test("execute calls macro and buffers nested metric", async () => {
    const sample = jest.fn(async () => 1.5)
    const macro = require("../../src/macro/bullmq")
    const orig = macro.jobQueueSize
    macro.jobQueueSize = sample
    try {
      jest.spyOn(Plan, "executable").mockReturnValue(true)
      jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
      Object.defineProperty(Plan.ADAPTERS, "bullmq", {
        get: () => macro,
        configurable: true,
      })
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const data = configuration.buffer.flush()
      expect(Object.values(data.worker.jqs)[0]).toBe(1.5)
    } finally {
      macro.jobQueueSize = orig
    }
  })

  test("execute rescues macro errors and logs without throwing", async () => {
    const macro = require("../../src/macro/bullmq")
    const orig = macro.jobQueueSize
    macro.jobQueueSize = async () => {
      throw new Error("broker down")
    }
    try {
      jest.spyOn(Plan, "executable").mockReturnValue(true)
      jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
      Object.defineProperty(Plan.ADAPTERS, "bullmq", {
        get: () => ({
          ...macro,
          supportsPlanStrategy: () => true,
          planOptions: () => ({}),
          planConnectionOptions: () => ({}),
          jobQueueSize: macro.jobQueueSize,
        }),
        configurable: true,
      })
      await expect(
        Plan.execute(
          {
            name: "worker",
            adapter: "bullmq",
            strategy: "jqs",
            queues: ["default"],
          },
          configuration,
        ),
      ).resolves.toBeUndefined()
      expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
      expect(configuration.logger.error).toHaveBeenCalledWith(
        expect.stringContaining("broker down"),
      )
    } finally {
      macro.jobQueueSize = orig
    }
  })

  test("execute unknown strategy logs and skips", async () => {
    await Plan.execute(
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "rpm",
        queues: [],
      },
      configuration,
    )
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown plan strategy"),
    )
  })

  test("execute merges planConnectionOptions into macro call", async () => {
    const sample = jest.fn(async () => 1)
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({ url: "redis://plan" }),
      jobQueueSize: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    await Plan.execute(
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "jqs",
        queues: ["default"],
      },
      configuration,
    )
    expect(sample).toHaveBeenCalledWith("default", { url: "redis://plan" })
  })

  test("normalize queues truncates to MAX_QUEUES and strips", async () => {
    const sample = jest.fn(async () => 1)
    const queues = Array.from(
      { length: Plan.MAX_QUEUES + 5 },
      (_, i) => ` q${i} `,
    )
    queues.push("")
    queues.push("a".repeat(Plan.MAX_QUEUE_NAME_BYTES + 1))
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    await Plan.execute(
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "jqs",
        queues,
      },
      configuration,
    )
    expect(sample.mock.calls[0].length - 1).toBe(Plan.MAX_QUEUES)
  })

  test("normalize queues non-array skips entry", async () => {
    const sample = jest.fn(async () => 1)
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    await Plan.execute(
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "jqs",
        queues: "not-array",
      },
      configuration,
    )
    expect(sample).not.toHaveBeenCalled()
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("must be an array"),
    )
  })

  test("normalize queues skips when all names invalid", async () => {
    const sample = jest.fn(async () => 1)
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    await Plan.execute(
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "jqs",
        queues: ["", "  "],
      },
      configuration,
    )
    expect(sample).not.toHaveBeenCalled()
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("no valid names"),
    )
  })

  test("aroundJobQueueSample calls before and after on every adapter", async () => {
    const events = []
    const a = {
      beforeSampleJobQueues: () => {
        events.push(["before", "a"])
        return "token_a"
      },
      afterSampleJobQueues: (token) => {
        events.push(["after", "a", token])
      },
    }
    const b = {
      beforeSampleJobQueues: () => {
        events.push(["before", "b"])
        return "token_b"
      },
      afterSampleJobQueues: (token) => {
        events.push(["after", "b", token])
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "a", {
      get: () => a,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(Plan.ADAPTERS, "b", {
      get: () => b,
      configurable: true,
      enumerable: true,
    })

    try {
      const result = await Plan.aroundJobQueueSample(() => {
        events.push("body")
        return "ok"
      }, configuration)
      expect(result).toBe("ok")
      expect(events).toEqual([
        ["before", "a"],
        ["before", "b"],
        "body",
        ["after", "a", "token_a"],
        ["after", "b", "token_b"],
      ])
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("aroundJobQueueSample runs after when body raises", async () => {
    const afterTokens = []
    const mod = {
      beforeSampleJobQueues: () => "wave",
      afterSampleJobQueues: (token) => {
        afterTokens.push(token)
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "x", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })

    try {
      await expect(
        Plan.aroundJobQueueSample(async () => {
          throw new Error("boom")
        }, configuration),
      ).rejects.toThrow("boom")
      expect(afterTokens).toEqual(["wave"])
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("reinitMacrosAfterFork notifies every adapter", async () => {
    const called = []
    const a = {
      reinitAfterFork: () => {
        called.push("a")
      },
    }
    const b = {
      reinitAfterFork: () => {
        called.push("b")
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "a", {
      get: () => a,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(Plan.ADAPTERS, "b", {
      get: () => b,
      configurable: true,
      enumerable: true,
    })

    try {
      await Plan.reinitMacrosAfterFork(configuration)
      expect(called).toEqual(["a", "b"])
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("aroundJobQueueSample continues when before raises and skips its after", async () => {
    const events = []
    const a = {
      beforeSampleJobQueues: () => {
        events.push(["before", "a"])
        throw new Error("before-a")
      },
      afterSampleJobQueues: (token) => {
        events.push(["after", "a", token])
      },
    }
    const b = {
      beforeSampleJobQueues: () => {
        events.push(["before", "b"])
        return "token_b"
      },
      afterSampleJobQueues: (token) => {
        events.push(["after", "b", token])
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "a", {
      get: () => a,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(Plan.ADAPTERS, "b", {
      get: () => b,
      configurable: true,
      enumerable: true,
    })

    try {
      const result = await Plan.aroundJobQueueSample(() => {
        events.push("body")
        return "ok"
      }, configuration)
      expect(result).toBe("ok")
      expect(events).toEqual([
        ["before", "a"],
        ["before", "b"],
        "body",
        ["after", "b", "token_b"],
      ])
      expect(configuration.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/beforeSampleJobQueues for "a" raised.*before-a/),
      )
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("aroundJobQueueSample continues remaining afters when one after raises", async () => {
    const events = []
    const a = {
      beforeSampleJobQueues: () => "token_a",
      afterSampleJobQueues: () => {
        events.push(["after", "a"])
        throw new Error("after-a")
      },
    }
    const b = {
      beforeSampleJobQueues: () => "token_b",
      afterSampleJobQueues: (token) => {
        events.push(["after", "b", token])
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "a", {
      get: () => a,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(Plan.ADAPTERS, "b", {
      get: () => b,
      configurable: true,
      enumerable: true,
    })

    try {
      await Plan.aroundJobQueueSample(() => {
        events.push("body")
      }, configuration)
      expect(events).toEqual([
        "body",
        ["after", "a"],
        ["after", "b", "token_b"],
      ])
      expect(configuration.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/afterSampleJobQueues for "a" raised.*after-a/),
      )
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("reinitMacrosAfterFork continues when one adapter raises", async () => {
    const called = []
    const a = {
      reinitAfterFork: () => {
        called.push("a")
        throw new Error("reinit-a")
      },
    }
    const b = {
      reinitAfterFork: () => {
        called.push("b")
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "a", {
      get: () => a,
      configurable: true,
      enumerable: true,
    })
    Object.defineProperty(Plan.ADAPTERS, "b", {
      get: () => b,
      configurable: true,
      enumerable: true,
    })

    try {
      await expect(
        Plan.reinitMacrosAfterFork(configuration),
      ).resolves.toBeUndefined()
      expect(called).toEqual(["a", "b"])
      expect(configuration.logger.error).toHaveBeenCalledWith(
        expect.stringMatching(/reinitAfterFork for "a" raised.*reinit-a/),
      )
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("allowlisted macros re-export sample-wave hooks as no-ops", () => {
    const Hooks = require("../../src/plan/hooks")
    for (const name of ["bull", "bullmq", "pg_boss"]) {
      const macro = require(`../../src/macro/${name}`)
      expect(macro.beforeSampleJobQueues).toBe(Hooks.beforeSampleJobQueues)
      expect(macro.afterSampleJobQueues).toBe(Hooks.afterSampleJobQueues)
      expect(macro.reinitAfterFork).toBe(Hooks.reinitAfterFork)
      expect(macro.beforeSampleJobQueues()).toBeNull()
      expect(macro.afterSampleJobQueues("token")).toBeUndefined()
      expect(macro.reinitAfterFork()).toBeUndefined()
    }
  })

  test("aroundJobQueueSample calls after with successful null token", async () => {
    const afterTokens = []
    const mod = {
      beforeSampleJobQueues: () => null,
      afterSampleJobQueues: (token) => {
        afterTokens.push(token)
      },
    }

    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }
    Object.defineProperty(Plan.ADAPTERS, "x", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })

    try {
      const result = await Plan.aroundJobQueueSample(() => "ok", configuration)
      expect(result).toBe("ok")
      expect(afterTokens).toEqual([null])
    } finally {
      for (const key of Object.keys(Plan.ADAPTERS)) {
        delete Plan.ADAPTERS[key]
      }
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("aroundJobQueueSample with empty adapters still runs body", async () => {
    const original = Object.getOwnPropertyDescriptors(Plan.ADAPTERS)
    for (const key of Object.keys(Plan.ADAPTERS)) {
      delete Plan.ADAPTERS[key]
    }

    try {
      const result = await Plan.aroundJobQueueSample(
        () => "empty",
        configuration,
      )
      expect(result).toBe("empty")
      expect(configuration.logger.error).not.toHaveBeenCalled()
    } finally {
      Object.defineProperties(Plan.ADAPTERS, original)
    }
  })

  test("execute samples wrk when macro implements jobQueueWorking", async () => {
    const mod = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: async (...queues) => {
        expect(queues.slice(0, -1)).toEqual(["default"])
        return 7
      },
      jobQueueWorking: async (...queues) => {
        expect(queues.slice(0, -1)).toEqual(["default"])
        return 3
      },
    }
    const original = Object.getOwnPropertyDescriptor(Plan.ADAPTERS, "bullmq")
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const data = configuration.buffer.flush()
      expect(Object.values(data.worker.jqs)[0]).toBe(7)
      expect(Object.values(data.worker.wrk)[0]).toBe(3)
    } finally {
      Object.defineProperty(Plan.ADAPTERS, "bullmq", original)
    }
  })

  test("execute skips wrk when job strategy sample is invalid", async () => {
    let workingCalled = false
    const mod = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: async () => -1,
      jobQueueWorking: async () => {
        workingCalled = true
        return 3
      },
    }
    const original = Object.getOwnPropertyDescriptor(Plan.ADAPTERS, "bullmq")
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const data = configuration.buffer.flush()
      expect(data.worker && data.worker.jqs).toBeUndefined()
      expect(data.worker && data.worker.wrk).toBeUndefined()
      expect(workingCalled).toBe(false)
    } finally {
      Object.defineProperty(Plan.ADAPTERS, "bullmq", original)
    }
  })

  test("execute skips wrk when macro lacks jobQueueWorking", async () => {
    const mod = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: async () => 5,
    }
    const original = Object.getOwnPropertyDescriptor(Plan.ADAPTERS, "bullmq")
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const data = configuration.buffer.flush()
      expect(Object.values(data.worker.jqs)[0]).toBe(5)
      expect(data.worker.wrk).toBeUndefined()
    } finally {
      Object.defineProperty(Plan.ADAPTERS, "bullmq", original)
    }
  })

  test("execute keeps jqs when jobQueueWorking raises", async () => {
    const mod = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: async () => 9,
      jobQueueWorking: async () => {
        throw new Error("wrk boom")
      },
    }
    const original = Object.getOwnPropertyDescriptor(Plan.ADAPTERS, "bullmq")
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const data = configuration.buffer.flush()
      expect(Object.values(data.worker.jqs)[0]).toBe(9)
      expect(data.worker.wrk).toBeUndefined()
      expect(configuration.logger.error).toHaveBeenCalled()
      const messages = configuration.logger.error.mock.calls.map((c) =>
        String(c[0]),
      )
      expect(messages.some((m) => m.includes("Plan working sampler"))).toBe(
        true,
      )
      expect(messages.some((m) => m.includes("wrk boom"))).toBe(true)
    } finally {
      Object.defineProperty(Plan.ADAPTERS, "bullmq", original)
    }
  })

  test("execute drops invalid wrk keeps jqs", async () => {
    const mod = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: async () => 4,
      jobQueueWorking: async () => -2,
    }
    const original = Object.getOwnPropertyDescriptor(Plan.ADAPTERS, "bullmq")
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => mod,
      configurable: true,
      enumerable: true,
    })
    try {
      await Plan.execute(
        {
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["default"],
        },
        configuration,
      )
      const data = configuration.buffer.flush()
      expect(Object.values(data.worker.jqs)[0]).toBe(4)
      expect(data.worker.wrk).toBeUndefined()
      const messages = configuration.logger.error.mock.calls.map((c) =>
        String(c[0]),
      )
      expect(messages.some((m) => m.includes("wrk sample dropped"))).toBe(true)
    } finally {
      Object.defineProperty(Plan.ADAPTERS, "bullmq", original)
    }
  })
})
