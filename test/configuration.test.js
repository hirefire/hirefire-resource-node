const Configuration = require("../src/configuration")
const { Web } = require("../src/web")

describe("Configuration", () => {
  let configuration

  beforeEach(() => {
    configuration = new Configuration()
  })

  test("default logger points to console", () => {
    expect(configuration.logger).toBe(console)
  })

  test("can set logger", () => {
    const customLogger = console
    configuration.logger = customLogger
    expect(configuration.logger).toBe(customLogger)
  })

  test("web defaults to null", () => {
    expect(configuration.web).toBeNull()
  })

  test("workers default to empty array", () => {
    expect(configuration.workers).toEqual([])
  })

  test("dyno configures web correctly", () => {
    configuration.dyno("web")
    expect(configuration.web).toBeInstanceOf(Web)
  })

  test("dyno adds function configuration to workers", async () => {
    const workerFn = async () => 1 + 1
    configuration.dyno("worker", workerFn)
    expect(configuration.workers.length).toBe(1)
    expect(configuration.workers[0].name).toBe("worker")
    expect(await configuration.workers[0].value()).toBe(2)
  })
})
