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
    expect(Plan.knownAdapter("sidekiq")).toBe(false)
    expect(Plan.knownStrategy("jqs")).toBe(true)
    expect(Plan.knownStrategy("jql")).toBe(true)
  })

  test("supports strategy jqs only for bullmq", () => {
    expect(Plan.supportsStrategy("bullmq", "jqs")).toBe(true)
    expect(Plan.supportsStrategy("bullmq", "jql")).toBe(false)
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
})
