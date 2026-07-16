require("./support")
const HireFire = require("../src/hirefire")
const Configuration = require("../src/configuration")
const Dispatcher = require("../src/dispatcher")

describe("HireFire", () => {
  test("configure yields the configuration", () => {
    const hirefire = new HireFire()
    let received
    hirefire.configure((config) => {
      received = config
    })
    expect(received).toBeInstanceOf(Configuration)
    expect(received).toBe(hirefire.configuration)
  })

  test("configure starts the dispatcher when a token is set", () => {
    process.env.HIREFIRE_TOKEN = "test-token-value"
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = new HireFire()
    hirefire.configure((config) => config.dyno("web"))

    expect(start).toHaveBeenCalled()
  })

  test("configure does not start the dispatcher without a token", () => {
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = new HireFire()
    hirefire.configure((config) => config.dyno("web"))

    expect(start).not.toHaveBeenCalled()
  })

  test("configure does not start the dispatcher with an empty token", () => {
    process.env.HIREFIRE_TOKEN = ""
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = new HireFire()
    hirefire.configure((config) => config.dyno("web"))

    expect(start).not.toHaveBeenCalled()
  })

  test("configure does not start the dispatcher when the token is forced empty", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = new HireFire()
    hirefire.configure((config) => {
      config.token = ""
      config.dyno("web")
    })

    expect(start).not.toHaveBeenCalled()
  })

  test("reset stops the dispatcher and replaces the configuration", async () => {
    const hirefire = new HireFire()
    hirefire.configuration.logger = { info() {}, warn() {}, error() {} }
    hirefire.configuration.dyno("web")
    const stop = jest.spyOn(hirefire.configuration.dispatcher, "stop")
    const previous = hirefire.configuration

    await hirefire.reset()

    expect(stop).toHaveBeenCalled()
    expect(hirefire.configuration).not.toBe(previous)
  })
})
