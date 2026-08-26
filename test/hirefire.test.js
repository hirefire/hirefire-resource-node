const HireFire = require("../src/hirefire")
const Configuration = require("../src/configuration")
const Dispatcher = require("../src/dispatcher")

describe("HireFire", () => {
  const instances = []

  function createHireFire() {
    const hirefire = new HireFire()
    instances.push(hirefire)
    return hirefire
  }

  afterEach(async () => {
    for (const hirefire of instances) {
      try {
        await hirefire.reset()
      } catch {}
    }
    instances.length = 0
  })

  test("configure yields the configuration", () => {
    const hirefire = createHireFire()
    let received
    hirefire.configure((config) => {
      received = config
    })
    expect(received).toBeInstanceOf(Configuration)
    expect(received).toBe(hirefire.configuration)
  })

  test("boot is configure with empty block", () => {
    process.env.HIREFIRE_TOKEN = "test-token-value"
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)
    const ensure = jest
      .spyOn(Dispatcher.prototype, "ensureJobQueueLoop")
      .mockImplementation(() => {})

    const hirefire = createHireFire()
    const config = hirefire.boot()

    expect(config).toBe(hirefire.configuration)
    expect(start).toHaveBeenCalled()
    expect(ensure).toHaveBeenCalled()
  })

  test("configure starts the dispatcher when a token is set", () => {
    process.env.HIREFIRE_TOKEN = "test-token-value"
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)
    const ensure = jest
      .spyOn(Dispatcher.prototype, "ensureJobQueueLoop")
      .mockImplementation(() => {})

    const hirefire = createHireFire()
    process.env.DYNO = "web.1"
    hirefire.configure(() => {})

    expect(start).toHaveBeenCalled()
    expect(ensure).toHaveBeenCalled()
  })

  test("configure does not start the dispatcher without a token", () => {
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = createHireFire()
    process.env.DYNO = "web.1"
    hirefire.configure(() => {})

    expect(start).not.toHaveBeenCalled()
  })

  test("configure does not start the dispatcher with an empty token", () => {
    process.env.HIREFIRE_TOKEN = ""
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = createHireFire()
    process.env.DYNO = "web.1"
    hirefire.configure(() => {})

    expect(start).not.toHaveBeenCalled()
  })

  test("configure does not start with whitespace only token", () => {
    process.env.HIREFIRE_TOKEN = "   "
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = createHireFire()
    process.env.DYNO = "web.1"
    hirefire.configure(() => {})

    expect(start).not.toHaveBeenCalled()
  })

  test("configure does not start the dispatcher when the token is forced empty", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)

    const hirefire = createHireFire()
    hirefire.configure((config) => {
      config.token = ""
      process.env.DYNO = "web.1"
    })

    expect(start).not.toHaveBeenCalled()
  })

  test("additive configure after boot starts ensure", () => {
    process.env.HIREFIRE_TOKEN = "test-token-value"
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)
    const ensure = jest
      .spyOn(Dispatcher.prototype, "ensureJobQueueLoop")
      .mockImplementation(() => {})

    const hirefire = createHireFire()
    hirefire.boot()
    hirefire.configure((config) => {
      config.dyno("worker", () => 1)
    })

    expect(ensure.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(start.mock.calls.length).toBeGreaterThanOrEqual(1)
  })

  test("additive configure after boot delivers live jql", async () => {
    const nock = require("nock")
    const { freezeTime } = require("./support")
    process.env.HIREFIRE_TOKEN = "test-token-value"
    nock("https://data.hirefire.io")
      .persist()
      .post("/metrics/lease")
      .reply(
        200,
        JSON.stringify({
          version: 1,
          job_queues: [
            {
              name: "worker",
              strategy: "jql",
              adapter: null,
              queues: [],
              options: {},
            },
          ],
        }),
        {
          "HireFire-Lease-Granted": "true",
          "HireFire-Sample-Frequency": "15",
        },
      )
    const bodies = []
    nock("https://data.hirefire.io")
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        bodies.push(body)
        return [200]
      })

    const hirefire = createHireFire()
    hirefire.configuration.logger = { info() {}, warn() {}, error() {} }
    hirefire.boot()
    expect(hirefire.configuration.dispatcher.running()).toBe(true)

    hirefire.configure((config) => {
      config.dyno("worker", () => 42)
    })
    expect(hirefire.configuration.dispatcher._jobLoopPromise).not.toBeNull()

    const dispatcher = hirefire.configuration.dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()

    expect(
      bodies.some((b) =>
        b.some((e) => e.name === "worker" && e.metrics && e.metrics.jql),
      ),
    ).toBe(true)
    await hirefire.reset()
  })

  test("reset stops the dispatcher and replaces the configuration", async () => {
    const hirefire = createHireFire()
    hirefire.configuration.logger = { info() {}, warn() {}, error() {} }
    process.env.DYNO = "web.1"
    const stop = jest.spyOn(hirefire.configuration.dispatcher, "stop")
    const previous = hirefire.configuration

    await hirefire.reset()

    expect(stop).toHaveBeenCalled()
    expect(hirefire.configuration).not.toBe(previous)
  })

  test("reset final-flushes old configuration buffer after swap", async () => {
    const nock = require("nock")
    const { freezeTime } = require("./support")
    process.env.HIREFIRE_TOKEN = "test-token-value"
    nock("https://data.hirefire.io")
      .persist()
      .post("/metrics/lease")
      .reply(200, "", {
        "HireFire-Lease-Granted": "false",
      })
    const bodies = []
    nock("https://data.hirefire.io")
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        bodies.push(body)
        return [200]
      })

    const hirefire = createHireFire()
    hirefire.configuration.logger = { info() {}, warn() {}, error() {} }
    hirefire.configure((config) => {
      process.env.DYNO = "web.1"
    })
    const previous = hirefire.configuration
    freezeTime(1000)
    previous.buffer.sample("web", "rqt", 7)

    await hirefire.reset()

    expect(hirefire.configuration).not.toBe(previous)
    expect(
      bodies.some((b) =>
        b.some((e) => e.name === "web" && e.metrics && e.metrics.rqt),
      ),
    ).toBe(true)
    expect(Object.keys(hirefire.configuration.buffer.flush())).toHaveLength(0)
  })

  test("reset is swap then stop", async () => {
    const hirefire = createHireFire()
    hirefire.configuration.logger = { info() {}, warn() {}, error() {} }
    const previous = hirefire.configuration
    const stop = jest.fn(async () => true)
    previous._dispatcher = {
      stop,
      start: () => true,
      ensureJobQueueLoop: () => {},
    }

    const resetPromise = hirefire.reset()
    expect(hirefire.configuration).not.toBe(previous)
    await resetPromise
    expect(stop).toHaveBeenCalled()
  })

  test("boot without token does not start dispatcher", () => {
    const start = jest.spyOn(Dispatcher.prototype, "start")
    const hirefire = createHireFire()
    hirefire.boot()
    expect(start).not.toHaveBeenCalled()
  })

  test("configure token assignment starts dispatcher and job-queue loop", () => {
    const start = jest
      .spyOn(Dispatcher.prototype, "start")
      .mockReturnValue(true)
    const ensure = jest
      .spyOn(Dispatcher.prototype, "ensureJobQueueLoop")
      .mockImplementation(() => {})
    const hirefire = createHireFire()
    hirefire.configure((config) => {
      config.token = "inline-token"
      config.dyno("worker", () => 1)
    })
    expect(start).toHaveBeenCalled()
    expect(ensure).toHaveBeenCalled()
  })
})
