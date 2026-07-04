const { freezeTime } = require("./support")
const nock = require("nock")
const HireFire = require("../src")
const Dispatcher = require("../src/dispatcher")
const Usage = require("../src/cpu/usage")

const BASE = "https://data.hirefire.io"

describe("Dispatcher", () => {
  let logger

  beforeEach(() => {
    process.env.HIREFIRE_TOKEN = "test-token-value"
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    HireFire.configuration.logger = logger
  })

  function config() {
    return HireFire.configuration
  }

  function stubLease(granted = false) {
    nock(BASE)
      .persist()
      .post("/metrics/lease")
      .reply(200, "", {
        "HireFire-Lease-Granted": String(granted),
        "HireFire-Sample-Frequency": "15",
      })
  }

  function captureIngestBodies() {
    const bodies = []
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        bodies.push(body)
        return [200]
      })
    return bodies
  }

  function configureWebAndWorkers() {
    config().dyno("web")
    config().dyno("worker", () => 42)
    config().dyno("mailer", () => 18)
    return config().dispatcher
  }

  function configureWebOnly() {
    config().dyno("web")
    return config().dispatcher
  }

  function configureWorkersOnly() {
    config().dyno("worker", () => 42)
    config().dyno("mailer", () => 18)
    return config().dispatcher
  }

  function configureCpuOnly(name = "clock") {
    process.env.HIREFIRE_SERVICE_NAME = name
    config().dyno(name, { tracking: "cpu" })
    return config().dispatcher
  }

  function loggedError(substring) {
    return logger.error.mock.calls.some((call) =>
      call.some((arg) => typeof arg === "string" && arg.includes(substring)),
    )
  }

  test("starts and stops", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()

    expect(dispatcher.running()).toBe(false)
    expect(dispatcher.start()).toBe(true)
    expect(dispatcher.running()).toBe(true)
    expect(dispatcher.start()).toBe(false)
    expect(await dispatcher.stop()).toBe(true)
    expect(dispatcher.running()).toBe(false)
    expect(await dispatcher.stop()).toBe(false)
  })

  test("dispatches web metrics", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    config().buffer.sampleWeb(12)
    config().buffer.sampleWeb(8)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].name).toBe("web")
    expect(Object.values(bodies[0][0].samples)[0]).toEqual([12, 8])
  })

  test("logs the payload when HIREFIRE_VERBOSE is set", async () => {
    process.env.HIREFIRE_VERBOSE = "1"
    captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    config().buffer.sampleWeb(12)
    await dispatcher._dispatchTick()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Dispatching metrics"),
    )
  })

  test("no dispatch when nothing is configured", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
  })

  test("first dispatch claims only the current second", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].samples).toEqual({ 1000: [] })
  })

  test("backfills seconds skipped between dispatches", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1003)
    await dispatcher._dispatchTick()

    expect(bodies[1][0].samples).toEqual({ 1001: [], 1002: [], 1003: [] })
  })

  test("backfill preserves buffered samples", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1003)
    config().buffer.sampleWeb(5)
    await dispatcher._dispatchTick()

    expect(bodies[1][0].samples).toEqual({ 1001: [], 1002: [], 1003: [5] })
  })

  test("seconds from a failed dispatch are reclaimed by the next success", async () => {
    const bodies = []
    let calls = 0
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        calls++
        bodies.push(body)
        return [calls === 2 ? 500 : 200]
      })

    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1003)
    await dispatcher._dispatchTick()
    freezeTime(1005)
    await dispatcher._dispatchTick()

    expect(Object.keys(bodies[2][0].samples).sort()).toEqual([
      "1001",
      "1002",
      "1003",
      "1004",
      "1005",
    ])
  })

  test("backfill is capped at the limit", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1100)
    await dispatcher._dispatchTick()

    const keys = Object.keys(bodies[1][0].samples).map(Number)
    expect(Math.min(...keys)).toBe(1100 - Dispatcher.WEB_BACKFILL_LIMIT)
    expect(Math.max(...keys)).toBe(1100)
    expect(keys.length).toBe(Dispatcher.WEB_BACKFILL_LIMIT + 1)
  })

  test("lease unauthorized does not log an error", async () => {
    nock(BASE).persist().post("/metrics/lease").reply(401)
    const bodies = captureIngestBodies()

    const dispatcher = configureWorkersOnly()
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
    expect(loggedError("401")).toBe(false)
  })

  test("web buffer discarded on unauthorized", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(401)

    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sampleWeb(7)
    await dispatcher._dispatchTick()

    expect(config().buffer.flush().web).toEqual({})
    expect(loggedError("Dispatch error")).toBe(false)
  })

  test("web buffer repopulated on dispatch failure", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(500)

    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sampleWeb(7)
    await dispatcher._dispatchTick()

    expect(config().buffer.flush().web).toEqual({ 1000: [7] })
  })

  test("oversized payload is dropped without a request", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    for (let i = 0; i < 15000; i++) config().buffer.sampleWeb(12345)
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
    expect(config().buffer.flush().web).toEqual({})
    expect(loggedError("Dropped metrics payload")).toBe(true)
  })

  test("an oversized payload without web data drops without touching the watermark", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()

    config().dyno("w".repeat(70000), () => 1)
    const dispatcher = config().dispatcher

    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
    expect(loggedError("Dropped metrics payload")).toBe(true)
    expect(dispatcher._lastWebSecond).toBeNull()
  })

  test("oversized drop advances the watermark past the hole", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1010)
    for (let i = 0; i < 15000; i++) config().buffer.sampleWeb(12345)
    await dispatcher._dispatchTick()
    freezeTime(1012)
    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(2)
    expect(Object.keys(bodies[1][0].samples).sort()).toEqual(["1011", "1012"])
  })

  test("dispatch tick does not run worker sampling", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()
    let sampled = false

    freezeTime(1000)
    config().dyno("web")
    config().dyno("worker", () => {
      sampled = true
      return 42
    })
    const dispatcher = config().dispatcher
    config().buffer.sampleWeb(5)

    await dispatcher._dispatchTick()

    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
    expect(sampled).toBe(false)
  })

  test("worker tick samples without dispatching and a later tick delivers it", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()

    freezeTime(1000)
    config().dyno("worker", () => 42)
    const dispatcher = config().dispatcher

    await dispatcher._workerTick()
    expect(bodies).toEqual([])

    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(1)
    expect(bodies[0].some((e) => e.name === "worker" && e.sample === 42)).toBe(
      true,
    )
  })

  test("combined web and worker dispatch", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()

    freezeTime(1000)
    const dispatcher = configureWebAndWorkers()
    config().buffer.sampleWeb(5)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    const entries = bodies[0]
    expect(entries.some((e) => e.name === "web" && "samples" in e)).toBe(true)
    expect(entries.some((e) => e.name === "worker" && e.sample === 42)).toBe(
      true,
    )
  })

  test("lease granted dispatches workers", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()

    const dispatcher = configureWorkersOnly()
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(bodies[0].some((e) => e.name === "worker" && e.sample === 42)).toBe(
      true,
    )
  })

  test("lease denied skips worker collection", async () => {
    stubLease(false)
    const bodies = captureIngestBodies()

    const dispatcher = configureWorkersOnly()
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
  })

  test("dispatches cpu samples in the samples format", async () => {
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce({ seconds: 0.0, source: "proc" })
      .mockReturnValueOnce({ seconds: 0.5, source: "proc" })
    const bodies = captureIngestBodies()

    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1001)
    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(1)
    expect(bodies[0][0].name).toBe("clock")
    expect(bodies[0][0].samples).toEqual({ 1001: [50.0] })
  })

  test("cpu first tick seeds the baseline without dispatching", async () => {
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 0.0, source: "proc" })
    const bodies = captureIngestBodies()

    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
  })

  test("cpu samples are not repopulated on dispatch failure", async () => {
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce({ seconds: 0.0, source: "proc" })
      .mockReturnValueOnce({ seconds: 0.5, source: "proc" })
    nock(BASE).persist().post("/metrics/ingest").reply(500)

    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1001)
    await dispatcher._dispatchTick()

    expect(config().buffer.flush().cpu).toEqual({})
  })

  test("non-web process does not heartbeat the web name", async () => {
    stubLease()
    process.env.DYNO = "worker.1"
    const bodies = captureIngestBodies()
    config().dyno("web")
    const dispatcher = config().dispatcher

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies).toEqual([])
  })

  test("non-web process still delivers real web samples", async () => {
    stubLease()
    process.env.DYNO = "worker.1"
    config().dyno("web")
    const dispatcher = config().dispatcher
    const bodies = captureIngestBodies()

    freezeTime(1000)
    config().buffer.sampleWeb(12)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].samples).toEqual({ 1000: [12] })
  })

  test("matching identity keeps heartbeat and backfill", async () => {
    process.env.DYNO = "web.1"
    config().dyno("web")
    const dispatcher = config().dispatcher
    const bodies = captureIngestBodies()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1002)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].samples).toEqual({ 1000: [] })
    expect(bodies[1][0].samples).toEqual({ 1001: [], 1002: [] })
  })

  test("unresolved identity keeps heartbeat", async () => {
    config().dyno("web")
    const dispatcher = config().dispatcher
    const bodies = captureIngestBodies()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].samples).toEqual({ 1000: [] })
  })

  test("mismatched cpu collector stays dormant through the tick", async () => {
    stubLease()
    const bodies = captureIngestBodies()

    process.env.HIREFIRE_SERVICE_NAME = "web"
    config().dyno("web")
    config().dyno("worker", { tracking: "cpu" })
    const dispatcher = config().dispatcher

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
  })

  test("tick dispatches when the lease request fails", async () => {
    nock(BASE)
      .persist()
      .post("/metrics/lease")
      .replyWithError({ code: "ECONNREFUSED" })
    const bodies = captureIngestBodies()

    freezeTime(1000)
    const dispatcher = configureWebAndWorkers()
    config().buffer.sampleWeb(12)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(1)
    expect(loggedError("Network error")).toBe(true)
  })

  test("tick dispatches when a sampler raises", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()

    freezeTime(1000)
    config().dyno("web")
    config().dyno("worker", () => {
      throw new Error("Redis down")
    })
    const dispatcher = config().dispatcher
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(1)
    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
    expect(loggedError("Redis down")).toBe(true)
  })

  test("the started loop dispatches until stopped", async () => {
    let dispatched
    const ran = new Promise((resolve) => (dispatched = resolve))
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(() => {
        dispatched()
        return [200]
      })

    const dispatcher = configureWebOnly()
    try {
      dispatcher.start()
      await ran
      expect(dispatcher.running()).toBe(true)
    } finally {
      await dispatcher.stop()
    }
    expect(dispatcher.running()).toBe(false)
  })

  test("the loop dispatches repeatedly across the sleep interval", async () => {
    let count = 0
    let reached
    const twoTicks = new Promise((resolve) => (reached = resolve))
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(() => {
        count++
        if (count >= 2) reached()
        return [200]
      })

    const dispatcher = configureWebOnly()
    dispatcher._interval = 0.01
    try {
      dispatcher.start()
      await twoTicks
      expect(count).toBeGreaterThanOrEqual(2)
    } finally {
      await dispatcher.stop()
    }
    expect(dispatcher.running()).toBe(false)
  })

  test("a hung worker sampler does not stall web dispatch", async () => {
    stubLease(true)
    let dispatched
    const webDispatched = new Promise((resolve) => (dispatched = resolve))
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(() => {
        dispatched()
        return [200]
      })

    let release
    const hang = new Promise((resolve) => (release = resolve))
    config().dyno("web")
    config().dyno("worker", () => hang)
    const dispatcher = config().dispatcher
    dispatcher._interval = 0.01

    try {
      dispatcher.start()
      await webDispatched
      expect(dispatcher.running()).toBe(true)
    } finally {
      release(0)
      await dispatcher.stop()
    }
  })

  test("stop flushes the buffer", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    dispatcher._running = true

    freezeTime(1000)
    config().buffer.sampleWeb(7)
    await dispatcher.stop()

    expect(bodies.length).toBe(1)
    expect(bodies[0][0].samples).toEqual({ 1000: [7] })
  })

  test("stop closes the persistent connections", async () => {
    const dispatcher = configureWorkersOnly()
    const clientClose = jest.spyOn(dispatcher._client, "close")
    const leaseClose = jest.spyOn(dispatcher._lease, "close")
    dispatcher._running = true

    await dispatcher.stop()

    expect(clientClose).toHaveBeenCalled()
    expect(leaseClose).toHaveBeenCalled()
  })

  test("stop is bounded when a loop is parked on a hung sampler", async () => {
    stubLease(true)
    captureIngestBodies()

    let reached
    const parked = new Promise((resolve) => (reached = resolve))
    config().dyno("web")
    config().dyno("worker", () => {
      reached()
      return new Promise(() => {})
    })
    const dispatcher = config().dispatcher
    dispatcher._interval = 0.01
    dispatcher._stopJoinTimeoutMs = 50

    const clientClose = jest.spyOn(dispatcher._client, "close")
    const leaseClose = jest.spyOn(dispatcher._lease, "close")

    dispatcher.start()
    await parked

    expect(await dispatcher.stop()).toBe(true)
    expect(clientClose).toHaveBeenCalled()
    expect(leaseClose).toHaveBeenCalled()
  })

  test("web-only dispatch never requests a lease", async () => {
    let leaseRequested = false
    nock(BASE)
      .persist()
      .post("/metrics/lease")
      .reply(() => {
        leaseRequested = true
        return [200, "", { "HireFire-Lease-Granted": "false" }]
      })
    nock(BASE).persist().post("/metrics/ingest").reply(200)

    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(leaseRequested).toBe(false)
  })

  function stubIngestWithDispatchFrequency(value) {
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(200, "", { "HireFire-Dispatch-Frequency": String(value) })
  }

  test("dispatch frequency defaults to one without the header", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1001)
    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(2)
  })

  test("honors a server-supplied dispatch frequency", async () => {
    let count = 0
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(() => {
        count++
        return [200, "", { "HireFire-Dispatch-Frequency": "5" }]
      })
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1002)
    await dispatcher._dispatchTick()
    freezeTime(1004)
    await dispatcher._dispatchTick()
    freezeTime(1005)
    await dispatcher._dispatchTick()

    expect(count).toBe(2)
  })

  test("clamps an over-large dispatch frequency to the maximum", async () => {
    stubIngestWithDispatchFrequency(Dispatcher.MAX_DISPATCH_FREQUENCY + 100)
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(dispatcher._dispatchFrequency).toBe(
      Dispatcher.MAX_DISPATCH_FREQUENCY,
    )
  })

  test("ignores a non-positive dispatch frequency", async () => {
    stubIngestWithDispatchFrequency(0)
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(dispatcher._dispatchFrequency).toBe(
      Dispatcher.DEFAULT_DISPATCH_FREQUENCY,
    )
  })

  test("ignores an unparseable dispatch frequency", async () => {
    stubIngestWithDispatchFrequency("nonsense")
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(dispatcher._dispatchFrequency).toBe(
      Dispatcher.DEFAULT_DISPATCH_FREQUENCY,
    )
  })

  test("dispatch pacing follows the monotonic clock, not the wall clock", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    jest.spyOn(Date, "now").mockReturnValue(1000000)
    let mono = 500000
    jest.spyOn(performance, "now").mockImplementation(() => mono)

    await dispatcher._dispatchTick()
    mono = 502000
    await dispatcher._dispatchTick()

    expect(bodies.length).toBe(2)
  })

  test("dispatch failure without web data does not repopulate", async () => {
    stubLease(true)
    nock(BASE).persist().post("/metrics/ingest").reply(500)

    const dispatcher = configureWorkersOnly()
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()

    expect(config().buffer.flush().web).toEqual({})
    expect(loggedError("Dispatch error")).toBe(true)
  })

  test("a guarded non-error throw does not crash the tick", async () => {
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    jest.spyOn(dispatcher._lease, "requestIfDue").mockImplementation(() => {
      throw null
    })

    await expect(dispatcher._workerTick()).resolves.toBeUndefined()
    expect(logger.error).toHaveBeenCalled()
  })

  test("a crashed loop is logged but leaves the dispatcher running", async () => {
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    const clientClose = jest.spyOn(dispatcher._client, "close")
    const leaseClose = jest.spyOn(dispatcher._lease, "close")
    jest
      .spyOn(dispatcher, "_dispatchTick")
      .mockRejectedValue(new Error("unexpected"))

    dispatcher.start()
    await dispatcher._loopPromise

    expect(loggedError("stopped unexpectedly")).toBe(true)
    expect(dispatcher.running()).toBe(true)

    expect(await dispatcher.stop()).toBe(true)
    expect(clientClose).toHaveBeenCalled()
    expect(leaseClose).toHaveBeenCalled()
  })

  test("a crashed dispatch loop does not stop the worker loop", async () => {
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()
    dispatcher._interval = 0.01
    jest
      .spyOn(dispatcher, "_dispatchTick")
      .mockRejectedValue(new Error("unexpected"))

    let calls = 0
    let ranTwice
    const twice = new Promise((resolve) => (ranTwice = resolve))
    jest
      .spyOn(dispatcher._lease, "requestIfDue")
      .mockImplementation(async () => {
        calls += 1
        if (calls >= 2) ranTwice()
      })

    try {
      dispatcher.start()
      await twice
      expect(dispatcher.running()).toBe(true)
    } finally {
      await dispatcher.stop()
    }

    expect(loggedError("stopped unexpectedly")).toBe(true)
  })

  test("a throwing logger cannot crash a dispatch", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    const dispatcher = configureWebOnly()
    config().logger = {
      info() {},
      warn() {},
      error() {
        throw new Error("logger is broken")
      },
    }
    freezeTime(1000)
    config().buffer.sampleWeb(7)

    await expect(dispatcher._dispatchTick()).resolves.toBeUndefined()
  })

  test("start is refused while a stop is in progress", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    dispatcher.start()

    const stopping = dispatcher.stop()
    expect(dispatcher.start()).toBe(false)
    await stopping
    expect(dispatcher.running()).toBe(false)
  })

  test("a dispatch never rejects, so a buffer failure cannot kill the loop", async () => {
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    jest.spyOn(config().buffer, "flush").mockImplementation(() => {
      throw null
    })

    await expect(dispatcher._dispatchTick()).resolves.toBeUndefined()
    expect(loggedError("Dispatch error")).toBe(true)
  })
})
