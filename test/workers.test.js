require("./support")
const Configuration = require("../src/configuration")
const Workers = require("../src/workers")
const Worker = require("../src/worker")

function configure() {
  const configuration = new Configuration()
  configuration.logger = { info() {}, warn() {}, error: jest.fn() }
  return configuration
}

describe("Workers", () => {
  test("samples each worker into the buffer", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 42)
    configuration.dyno("mailer", () => 18)

    await configuration.workers.sample()

    expect(configuration.buffer.flush().workers).toEqual([
      { name: "worker", sample: 42 },
      { name: "mailer", sample: 18 },
    ])
  })

  test("latest sample wins across multiple samples", async () => {
    const configuration = configure()
    const values = [5, 9]
    let i = 0
    configuration.dyno("worker", () => values[i++])

    await configuration.workers.sample()
    await configuration.workers.sample()

    expect(configuration.buffer.flush().workers).toEqual([
      { name: "worker", sample: 9 },
    ])
  })

  test("a raising sampler is isolated and logged", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => {
      throw new Error("Redis down")
    })
    configuration.dyno("mailer", () => 18)

    await configuration.workers.sample()

    expect(configuration.buffer.flush().workers).toEqual([
      { name: "mailer", sample: 18 },
    ])
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Redis down"),
    )
  })

  test("invalid sample values are dropped and logged", async () => {
    const configuration = configure()
    const values = ["10", null, -1, Infinity, NaN, 7]
    let i = 0
    configuration.dyno("worker", () => values[i++])

    for (let n = 0; n < 5; n++) await configuration.workers.sample()
    expect(configuration.buffer.flush().workers).toEqual([])
    expect(configuration.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("expected a non-negative number"),
    )

    await configuration.workers.sample()
    expect(configuration.buffer.flush().workers).toEqual([
      { name: "worker", sample: 7 },
    ])
  })

  test("a zero sample is accepted", async () => {
    const configuration = configure()
    configuration.dyno("worker", () => 0)

    await configuration.workers.sample()

    // 0 is a valid idle-queue reading, not a sampler failure.
    expect(configuration.buffer.flush().workers).toEqual([
      { name: "worker", sample: 0 },
    ])
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
