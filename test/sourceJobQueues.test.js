require("./support")
const Configuration = require("../src/configuration")
const JobQueues = require("../src/source/jobQueues")
const JobQueue = require("../src/source/jobQueue")

function configure() {
  const configuration = new Configuration()
  configuration.logger = { info() {}, warn() {}, error: jest.fn() }
  return configuration
}

function strategyValue(data, name, strategy) {
  return Object.values(data[name][strategy])[0]
}

describe("JobQueues", () => {
  test("samples each job queue into the buffer under plan strategy", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 42)
    configuration.dyno("mailer", () => 18)

    for (const jobQueue of configuration.jobQueues) {
      await configuration.jobQueues.sampleJobQueue(jobQueue, "jql")
    }

    const data = configuration.buffer.flush()
    expect(strategyValue(data, "worker", "jql")).toBe(42)
    expect(strategyValue(data, "mailer", "jql")).toBe(18)
  })

  test("samples under jqs strategy", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 7)
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "jqs",
    )
    expect(strategyValue(configuration.buffer.flush(), "worker", "jqs")).toBe(7)
  })

  test("findByName is case insensitive", () => {
    const configuration = configure()
    configuration.dyno("Worker", () => 1)
    expect(configuration.jobQueues.findByName("worker").name).toBe("Worker")
    expect(configuration.jobQueues.findByName("WORKER")).toBe(
      configuration.jobQueues.findByName("worker"),
    )
  })

  test("findByName returns null for missing", () => {
    const configuration = configure()
    configuration.dyno("worker", () => 1)
    expect(configuration.jobQueues.findByName("missing")).toBeNull()
  })

  test("latest sample wins across multiple samples", async () => {
    const configuration = configure()
    const values = [5, 9]
    let i = 0
    configuration.dyno("worker", () => values[i++])
    const jobQueue = configuration.jobQueues.findByName("worker")
    await configuration.jobQueues.sampleJobQueue(jobQueue, "jql")
    await configuration.jobQueues.sampleJobQueue(jobQueue, "jql")
    expect(strategyValue(configuration.buffer.flush(), "worker", "jql")).toBe(9)
  })

  test("a raising sampler is isolated and logged", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => {
      throw new Error("Redis down")
    })
    configuration.dyno("mailer", () => 18)

    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "jql",
    )
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("mailer"),
      "jql",
    )

    const data = configuration.buffer.flush()
    expect(data.worker).toBeUndefined()
    expect(strategyValue(data, "mailer", "jql")).toBe(18)
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Redis down"),
    )
  })

  test("invalid sample values are dropped and logged", async () => {
    const configuration = configure()
    const values = ["10", null, -1, Infinity, NaN, 7]
    let i = 0
    configuration.dyno("worker", () => values[i++])
    const jobQueue = configuration.jobQueues.findByName("worker")

    for (let n = 0; n < 5; n++) {
      await configuration.jobQueues.sampleJobQueue(jobQueue, "jql")
    }
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)

    await configuration.jobQueues.sampleJobQueue(jobQueue, "jql")
    expect(strategyValue(configuration.buffer.flush(), "worker", "jql")).toBe(7)
  })

  test("a zero sample is accepted", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 0)
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "jql",
    )
    expect(strategyValue(configuration.buffer.flush(), "worker", "jql")).toBe(0)
  })

  test("is iterable and exposes map", () => {
    const jobQueues = new JobQueues({})
    jobQueues.add(new JobQueue("worker", () => 1))
    jobQueues.add(new JobQueue("mailer", () => 2))

    expect(jobQueues.map((q) => q.name)).toEqual(["worker", "mailer"])
    expect([...jobQueues].map((q) => q.name)).toEqual(["worker", "mailer"])
  })

  test("any and count", () => {
    const jobQueues = new JobQueues({})
    expect(jobQueues.any()).toBe(false)
    expect(jobQueues.count()).toBe(0)

    jobQueues.add(new JobQueue("worker", () => 1))
    expect(jobQueues.any()).toBe(true)
    expect(jobQueues.count()).toBe(1)
  })

  test("unknown strategy is dropped and logged", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 1)
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "rpm",
    )
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Unknown job-queue strategy"),
    )
  })

  test("a raising logger does not escape sampling", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => {
      throw new Error("Redis down")
    })
    configuration.logger = {
      info() {},
      warn() {},
      error() {
        throw new Error("closed stream")
      },
    }
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "jql",
    )
  })

  test("samples write to the owning configuration not the global", async () => {
    process.env.HIREFIRE_TOKEN = "old-token"
    const old = new Configuration()
    old.dyno("worker", () => 7)
    const jobQueue = old.jobQueues.findByName("worker")

    const HireFire = require("../src")
    await HireFire.reset()
    process.env.HIREFIRE_TOKEN = "new-token"
    HireFire.configuration.dyno("web")

    await old.jobQueues.sampleJobQueue(jobQueue, "jql")

    expect(HireFire.configuration.buffer.flush().worker).toBeUndefined()
    expect(strategyValue(old.buffer.flush(), "worker", "jql")).toBe(7)
  })

  test("live gate drops a sample that returns after stop", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 9)
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "jql",
      { live: () => false },
    )
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
  })

  test("sampleJobQueue reports under an explicit name", async () => {
    const configuration = configure()
    configuration.dyno("Worker", () => 7)
    await configuration.jobQueues.sampleJobQueue(
      configuration.jobQueues.findByName("worker"),
      "jqs",
      { name: "worker" },
    )
    const data = configuration.buffer.flush()
    expect(strategyValue(data, "worker", "jqs")).toBe(7)
    expect(data.Worker).toBeUndefined()
  })
})
