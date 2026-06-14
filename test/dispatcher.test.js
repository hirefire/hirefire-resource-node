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
    expect(dispatcher.start()).toBe(false) // idempotent
    expect(await dispatcher.stop()).toBe(true)
    expect(dispatcher.running()).toBe(false)
    expect(await dispatcher.stop()).toBe(false) // idempotent
  })

  test("dispatches web metrics", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    config().buffer.sampleWeb(12)
    config().buffer.sampleWeb(8)
    await dispatcher._tick()

    expect(bodies[0][0].name).toBe("web")
    expect(Object.values(bodies[0][0].samples)[0]).toEqual([12, 8])
  })

  test("logs the payload when HIREFIRE_VERBOSE is set", async () => {
    process.env.HIREFIRE_VERBOSE = "1"
    captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    config().buffer.sampleWeb(12)
    await dispatcher._tick()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Dispatching metrics"),
    )
  })

  test("no dispatch when nothing is configured", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    await dispatcher._tick()

    expect(bodies).toEqual([])
  })

  test("first dispatch claims only the current second", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._tick()

    expect(bodies[0][0].samples).toEqual({ 1000: [] })
  })

  test("backfills seconds skipped between dispatches", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._tick()
    freezeTime(1003)
    await dispatcher._tick()

    expect(bodies[1][0].samples).toEqual({ 1001: [], 1002: [], 1003: [] })
  })

  test("backfill preserves buffered samples", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._tick()
    freezeTime(1003)
    config().buffer.sampleWeb(5)
    await dispatcher._tick()

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
    await dispatcher._tick() // 200 — watermark 1000
    freezeTime(1003)
    await dispatcher._tick() // 500 — watermark holds
    freezeTime(1005)
    await dispatcher._tick() // 200 — reclaims 1001..1005

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
    await dispatcher._tick()
    freezeTime(1100)
    await dispatcher._tick()

    const keys = Object.keys(bodies[1][0].samples).map(Number)
    expect(Math.min(...keys)).toBe(1100 - Dispatcher.WEB_BACKFILL_LIMIT)
    expect(Math.max(...keys)).toBe(1100)
    expect(keys.length).toBe(Dispatcher.WEB_BACKFILL_LIMIT + 1)
  })

  test("lease unauthorized does not log an error", async () => {
    nock(BASE).persist().post("/metrics/lease").reply(401)
    const bodies = captureIngestBodies()

    const dispatcher = configureWorkersOnly()
    await dispatcher._tick()

    expect(bodies).toEqual([])
    expect(loggedError("401")).toBe(false)
  })

  test("web buffer discarded on unauthorized", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(401)

    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sampleWeb(7)
    await dispatcher._tick()

    expect(config().buffer.flush().web).toEqual({})
    expect(loggedError("Dispatch error")).toBe(false)
  })

  test("web buffer repopulated on dispatch failure", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(500)

    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sampleWeb(7)
    await dispatcher._tick()

    expect(config().buffer.flush().web).toEqual({ 1000: [7] })
  })

  test("oversized payload is dropped without a request", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    for (let i = 0; i < 15000; i++) config().buffer.sampleWeb(12345)
    await dispatcher._tick()

    expect(bodies).toEqual([])
    expect(config().buffer.flush().web).toEqual({})
    expect(loggedError("Dropped metrics payload")).toBe(true)
  })

  test("oversized drop advances the watermark past the hole", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._tick() // watermark 1000
    freezeTime(1010)
    for (let i = 0; i < 15000; i++) config().buffer.sampleWeb(12345)
    await dispatcher._tick() // oversized — dropped, watermark advances to 1010
    freezeTime(1012)
    await dispatcher._tick()

    expect(bodies.length).toBe(2)
    expect(Object.keys(bodies[1][0].samples).sort()).toEqual(["1011", "1012"])
  })

  test("combined web and worker dispatch", async () => {
    stubLease(true)
    const bodies = captureIngestBodies()

    freezeTime(1000)
    const dispatcher = configureWebAndWorkers()
    config().buffer.sampleWeb(5)
    await dispatcher._tick()

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
    await dispatcher._tick()

    expect(bodies[0].some((e) => e.name === "worker" && e.sample === 42)).toBe(
      true,
    )
  })

  test("lease denied skips worker collection", async () => {
    stubLease(false)
    const bodies = captureIngestBodies()

    const dispatcher = configureWorkersOnly()
    await dispatcher._tick()

    expect(bodies).toEqual([])
  })

  test("dispatches cpu samples in the samples format", async () => {
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.5)
    const bodies = captureIngestBodies()

    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._tick() // seeds baseline only
    freezeTime(1001)
    await dispatcher._tick() // 0.5 core over 1s => 50%

    expect(bodies.length).toBe(1)
    expect(bodies[0][0].name).toBe("clock")
    expect(bodies[0][0].samples).toEqual({ 1001: [50.0] })
  })

  test("cpu first tick seeds the baseline without dispatching", async () => {
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)
    jest.spyOn(Usage, "totalSeconds").mockReturnValue(0.0)
    const bodies = captureIngestBodies()

    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._tick()

    expect(bodies).toEqual([])
  })

  test("cpu samples are not repopulated on dispatch failure", async () => {
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(0.5)
    nock(BASE).persist().post("/metrics/ingest").reply(500)

    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._tick()
    freezeTime(1001)
    await dispatcher._tick() // 500 — sample dropped, not re-buffered

    expect(config().buffer.flush().cpu).toEqual({})
  })

  test("non-web process does not heartbeat the web name", async () => {
    stubLease()
    process.env.DYNO = "worker.1"
    const bodies = captureIngestBodies()
    config().dyno("web")
    const dispatcher = config().dispatcher

    freezeTime(1000)
    await dispatcher._tick()

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
    await dispatcher._tick()

    expect(bodies[0][0].samples).toEqual({ 1000: [12] })
  })

  test("matching identity keeps heartbeat and backfill", async () => {
    process.env.DYNO = "web.1"
    config().dyno("web")
    const dispatcher = config().dispatcher
    const bodies = captureIngestBodies()

    freezeTime(1000)
    await dispatcher._tick()
    freezeTime(1002)
    await dispatcher._tick()

    expect(bodies[0][0].samples).toEqual({ 1000: [] })
    expect(bodies[1][0].samples).toEqual({ 1001: [], 1002: [] })
  })

  test("unresolved identity keeps heartbeat", async () => {
    config().dyno("web")
    const dispatcher = config().dispatcher
    const bodies = captureIngestBodies()

    freezeTime(1000)
    await dispatcher._tick()

    expect(bodies[0][0].samples).toEqual({ 1000: [] })
  })

  test("mismatched cpu collector stays dormant through the tick", async () => {
    stubLease()
    const bodies = captureIngestBodies()

    process.env.HIREFIRE_SERVICE_NAME = "web"
    config().dyno("web")
    config().dyno("worker", { tracking: "cpu" }) // dormant here: identity is "web"
    const dispatcher = config().dispatcher

    freezeTime(1000)
    await dispatcher._tick()

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
    await dispatcher._tick()

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
    await dispatcher._tick()

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
    dispatcher.start()
    await ran // block until the background loop runs a real tick
    expect(dispatcher.running()).toBe(true)

    await dispatcher.stop()
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
    dispatcher._interval = 0.01 // 10ms between ticks, so the sleep path runs fast
    dispatcher.start()
    await twoTicks // tick -> sleep -> tick proves the loop resumes after sleeping

    await dispatcher.stop() // stops mid-sleep, exercising the wake path
    expect(count).toBeGreaterThanOrEqual(2)
    expect(dispatcher.running()).toBe(false)
  })

  test("stop flushes the buffer", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    // Mark running without spawning the loop, so the only dispatch is stop's.
    dispatcher._running = true

    freezeTime(1000)
    config().buffer.sampleWeb(7)
    await dispatcher.stop()

    expect(bodies.length).toBe(1)
    expect(bodies[0][0].samples).toEqual({ 1000: [7] })
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
    await dispatcher._tick()

    expect(leaseRequested).toBe(false)
  })

  test("dispatch failure without web data does not repopulate", async () => {
    stubLease(true)
    nock(BASE).persist().post("/metrics/ingest").reply(500)

    const dispatcher = configureWorkersOnly()
    await dispatcher._tick() // 500 — workers-only, so web data is empty

    expect(config().buffer.flush().web).toEqual({})
    expect(loggedError("Dispatch error")).toBe(true)
  })
})
