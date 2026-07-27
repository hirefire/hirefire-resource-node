require("./support")
const Configuration = require("../src/configuration")
const Workers = require("../src/workers")
const Worker = require("../src/worker")

function configure() {
  const configuration = new Configuration()
  configuration.logger = { info() {}, warn() {}, error: jest.fn() }
  return configuration
}

function strategyValue(data, name, strategy) {
  return Object.values(data[name][strategy])[0]
}

describe("Workers", () => {
  test("samples each worker into the buffer under plan strategy", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 42)
    configuration.dyno("mailer", () => 18)

    for (const worker of configuration.workers) {
      await configuration.workers.sampleJobQueue(worker, "jql")
    }

    const data = configuration.buffer.flush()
    expect(strategyValue(data, "worker", "jql")).toBe(42)
    expect(strategyValue(data, "mailer", "jql")).toBe(18)
  })

  test("samples under jqs strategy", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 7)
    await configuration.workers.sampleJobQueue(
      configuration.workers.findByName("worker"),
      "jqs",
    )
    expect(strategyValue(configuration.buffer.flush(), "worker", "jqs")).toBe(7)
  })

  test("findByName is case insensitive", () => {
    const configuration = configure()
    configuration.dyno("Worker", () => 1)
    expect(configuration.workers.findByName("worker").name).toBe("Worker")
  })

  test("a raising sampler is isolated and logged", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => {
      throw new Error("Redis down")
    })
    configuration.dyno("mailer", () => 18)

    await configuration.workers.sampleJobQueue(
      configuration.workers.findByName("worker"),
      "jql",
    )
    await configuration.workers.sampleJobQueue(
      configuration.workers.findByName("mailer"),
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
    const worker = configuration.workers.findByName("worker")

    for (let n = 0; n < 5; n++) {
      await configuration.workers.sampleJobQueue(worker, "jql")
    }
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)

    await configuration.workers.sampleJobQueue(worker, "jql")
    expect(strategyValue(configuration.buffer.flush(), "worker", "jql")).toBe(7)
  })

  test("a zero sample is accepted", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 0)
    await configuration.workers.sampleJobQueue(
      configuration.workers.findByName("worker"),
      "jql",
    )
    expect(strategyValue(configuration.buffer.flush(), "worker", "jql")).toBe(0)
  })

  test("is iterable and exposes map", () => {
    const workers = new Workers({})
    workers.add(new Worker("worker", () => 1))
    workers.add(new Worker("mailer", () => 2))

    expect(workers.map((w) => w.name)).toEqual(["worker", "mailer"])
    expect([...workers].map((w) => w.name)).toEqual(["worker", "mailer"])
  })

  test("any and count", () => {
    const workers = new Workers({})
    expect(workers.any()).toBe(false)
    expect(workers.count()).toBe(0)

    workers.add(new Worker("worker", () => 1))
    expect(workers.any()).toBe(true)
    expect(workers.count()).toBe(1)
  })
})
