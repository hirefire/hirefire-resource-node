const { freezeTime } = require("./support")
const nock = require("nock")
const HireFire = require("../src")
const Dispatcher = require("../src/dispatcher")
const MetricsBuffer = require("../src/buffer")
const Usage = require("../src/source/cpu/usage")
const Plan = require("../src/plan")

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

  function stubLease(granted = false, body = "") {
    nock(BASE)
      .persist()
      .post("/metrics/lease")
      .reply(200, body, {
        "HireFire-Lease-Granted": String(granted),
        "HireFire-Sample-Frequency": "15",
      })
  }

  function injectOversizedSeries(name = "web", strategy = "rqt") {
    const buffer = config().buffer
    const now = Math.floor(Date.now() / 1000)
    const cell = strategy === "rqt" ? { sum: 1, count: 1 } : 1
    for (let i = 0; i < 400; i++) {
      const processName = `p${i}-${"x".repeat(48)}`
      const series = {}
      for (let s = 0; s < 60; s++) {
        series[now - s] = cell
      }
      buffer._metrics[processName] = { [strategy]: series }
    }
    if (!buffer._metrics[name]) buffer._metrics[name] = {}
    buffer._metrics[name][strategy] = { [now]: cell }
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
    process.env.DYNO = "web.1"
    config().dyno("worker", () => 42)
    config().dyno("mailer", () => 18)
    return config().dispatcher
  }

  function configureWebOnly() {
    process.env.DYNO = "web.1"
    return config().dispatcher
  }

  function configureWorkersOnly() {
    config().dyno("worker", () => 42)
    config().dyno("mailer", () => 18)
    return config().dispatcher
  }

  function configureCpuOnly(name = "clock") {
    process.env.HIREFIRE_SERVICE_NAME = name
    return config().dispatcher
  }

  function defaultGrantBody(trace = false) {
    const payload = {
      version: 1,
      job_queues: [
        {
          name: "worker",
          strategy: "jql",
          adapter: null,
          queues: [],
          options: {},
        },
        {
          name: "mailer",
          strategy: "jql",
          adapter: null,
          queues: [],
          options: {},
        },
      ],
    }
    if (trace) payload.trace = true
    return JSON.stringify(payload)
  }

  function stubGrantedLease(body = defaultGrantBody()) {
    stubLease(true, body)
  }

  function stubIngestWithDispatchFrequency(value) {
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(200, "", { "HireFire-Dispatch-Frequency": String(value) })
  }

  function loggerErrors() {
    return logger.error.mock.calls.map((c) => String(c[0])).join("\n")
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

  test("stop closes keep alive even when never started", async () => {
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await dispatcher._dispatchTick()
    expect(dispatcher._client._agent).not.toBeNull()
    expect(await dispatcher.stop()).toBe(false)
    expect(dispatcher._client._agent).toBeNull()
  })

  test("first start does not clear pre start rqt", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    config().buffer.sample("web", "rqt", 7)
    expect(dispatcher.start()).toBe(true)
    const flushed = config().buffer.flush()
    expect(flushed.web.rqt).toBeDefined()
    await dispatcher.stop()
  })

  test("dispatches web metrics", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    config().buffer.sample("web", "rqt", 12)
    config().buffer.sample("web", "rqt", 8)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].name).toBe("web")
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([10, 2])
  })

  test("dispatches jqs and wrk as sibling bare numbers", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const dispatcher = configureWebAndWorkers()

    freezeTime(2500)
    config().buffer.sample("worker", "jqs", 12)
    config().buffer.sample("worker", "wrk", 3)
    await dispatcher._dispatchTick()

    expect(bodies.length).toBeGreaterThan(0)
    const entry = bodies[bodies.length - 1].find((e) => e.name === "worker")
    expect(entry).toBeDefined()
    const jqsLeaf = entry.metrics.jqs["2500"]
    const wrkLeaf = entry.metrics.wrk["2500"]
    expect(jqsLeaf).toBe(12)
    expect(wrkLeaf).toBe(3)
    expect(typeof jqsLeaf).toBe("number")
    expect(typeof wrkLeaf).toBe("number")
    expect(Array.isArray(wrkLeaf)).toBe(false)
  })

  test("encodes rqt leaf as mean and count", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 20)
    config().buffer.sample("web", "rqt", 20)
    config().buffer.sample("web", "rqt", 20)
    await dispatcher._dispatch()
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([20, 3])
  })

  test("encode clamps rqt sample count to limit", () => {
    const dispatcher = configureWebOnly()
    const leaf = dispatcher._encodeLeaf("rqt", {
      sum: Dispatcher.SAMPLE_COUNT_LIMIT * 2,
      count: Dispatcher.SAMPLE_COUNT_LIMIT + 5,
    })
    expect(leaf[1]).toBe(Dispatcher.SAMPLE_COUNT_LIMIT)
    expect(Number.isInteger(leaf[1])).toBe(true)
  })

  test("merges duplicate rqt fragments before encoding", () => {
    const dispatcher = configureWebOnly()
    const entriesByName = Object.create(null)

    dispatcher._mergeMetrics(entriesByName, "web", "rqt", {
      1000: { sum: 2, count: 1 },
    })
    dispatcher._mergeMetrics(entriesByName, "web", "rqt", {
      1000: { sum: 6, count: 2 },
    })

    expect(entriesByName.web.rqt[1000]).toEqual({ sum: 8, count: 3 })
  })

  test("oversized payload is dropped without a request", async () => {
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher

    freezeTime(1000)
    injectOversizedSeries()
    await dispatcher._dispatch()
    expect(bodies).toEqual([])
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes("Dropped metrics payload"),
      ),
    ).toBe(true)
  })

  test("dead generation does not drop an oversized payload", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    injectOversizedSeries()
    dispatcher._generation = 1
    dispatcher._running = true
    const buildPayload = dispatcher._buildPayload.bind(dispatcher)
    dispatcher._buildPayload = (...args) => {
      const result = buildPayload(...args)
      dispatcher._running = false
      return result
    }

    await dispatcher._dispatch(1)

    expect(bodies).toEqual([])
    expect(dispatcher._lastRqtSecond).toBeNull()
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("payload equality at 32768 posts", async () => {
    const dispatcher = configureWebOnly()
    const exact = "x".repeat(Dispatcher.PAYLOAD_SIZE_LIMIT)
    expect(Buffer.byteLength(exact)).toBe(32768)
    const drop = dispatcher._dropOversizedPayload.bind(dispatcher)
    let dropped = false
    dispatcher._dropOversizedPayload = (...args) => {
      dropped = true
      return drop(...args)
    }
    const orig = dispatcher._client.submitSamples
    let posted = false
    dispatcher._client.submitSamples = async () => {
      posted = true
      return { statusCode: 200, headers: {} }
    }
    const body = JSON.stringify([
      { name: "web", metrics: { rqt: { 1000: [] } } },
    ])
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(
      Dispatcher.PAYLOAD_SIZE_LIMIT,
    )
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 1)
    await dispatcher._dispatch()
    expect(posted).toBe(true)
    expect(dropped).toBe(false)
    dispatcher._client.submitSamples = orig
  })

  test("logs the payload when verbose is set", async () => {
    process.env.HIREFIRE_VERBOSE = "1"
    captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    config().buffer.sample("web", "rqt", 12)
    await dispatcher._dispatchTick()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Dispatching metrics"),
    )
  })

  test("first dispatch claims only the current second", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [] })
  })

  test("unresolved identity does not synthesize liveness", async () => {
    const bodies = captureIngestBodies()
    config().dyno("web")
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
  })

  test("always on cpu uses identity name through the tick", async () => {
    process.env.DYNO = "worker.1"
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 1.0, source: "process" })
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher

    freezeTime(1000)
    await dispatcher._dispatchTick()
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 1.5, source: "process" })
    freezeTime(1001)
    await dispatcher._dispatchTick()

    const cpuEntry = bodies.find((b) => b.some((e) => e.name === "worker"))
    expect(cpuEntry).toBeDefined()
  })

  test("always on rqt under dyno web without declaration", async () => {
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await dispatcher._dispatchTick()
    expect(bodies[0][0].name).toBe("web")
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([5, 1])
  })

  test("flushes buffered rqt when liveness is disabled", () => {
    const dispatcher = configureWebOnly()
    Object.defineProperties(config(), {
      httpName: { configurable: true, value: "web" },
      rqtEnabled: { configurable: true, value: true },
      rqtLiveness: { configurable: true, value: false },
    })

    const result = dispatcher._buildPayload({
      web: { rqt: { 1000: { sum: 7, count: 1 } } },
    })

    expect(result.entries).toEqual([
      { name: "web", metrics: { rqt: { 1000: [7, 1] } } },
    ])
    expect(result.watermark).toBeUndefined()
  })

  test("omits rqt means outside the wire range", () => {
    const dispatcher = configureWebOnly()

    expect(dispatcher._encodeLeaf("rqt", { sum: -1, count: 1 })).toBeUndefined()
    expect(
      dispatcher._encodeLeaf("rqt", {
        sum: Dispatcher.METRIC_VALUE_LIMIT + 1,
        count: 1,
      }),
    ).toBeUndefined()
  })

  test("stop without flush discards buffer", async () => {
    stubLease()
    const dispatcher = configureWebOnly()
    dispatcher.start()
    config().buffer.sample("web", "rqt", 9)
    await dispatcher.stop({ flush: false })
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("stop flushes the buffer", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 9)
    dispatcher.start()
    await dispatcher.stop({ flush: true })
    expect(bodies.length).toBeGreaterThan(0)
  })

  test("start after stop resets pacing and demotes lease", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()
    dispatcher.start()
    dispatcher._nextDispatchAt = performance.now() + 60000
    dispatcher._lastRqtSecond = 999
    dispatcher._lease._granted = true
    await dispatcher.stop()
    dispatcher.start()
    expect(dispatcher._nextDispatchAt).toBeNull()
    expect(dispatcher._lastRqtSecond).toBeNull()
    expect(dispatcher._lease.granted()).toBe(false)
    await dispatcher.stop()
  })

  test("dispatch with stale generation does not post", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    dispatcher._generation = 1
    await dispatcher._dispatch(0)
    expect(bodies).toEqual([])
  })

  test("dispatch dead gen after successful post skips watermark", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    dispatcher._generation = 1
    dispatcher._running = true
    const origSubmit = dispatcher._client.submitSamples.bind(dispatcher._client)
    dispatcher._client.submitSamples = async (body) => {
      dispatcher._running = false
      return origSubmit(body)
    }
    await dispatcher._dispatch(1)
    expect(bodies.length).toBe(1)
    expect(dispatcher._lastRqtSecond).toBeNull()
  })

  test("web buffer repopulated on dispatch failure", async () => {
    nock(BASE).post("/metrics/ingest").replyWithError({ code: "ECONNREFUSED" })
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    dispatcher._generation = 1
    dispatcher._running = true
    await dispatcher._dispatch(1)
    const data = config().buffer.flush()
    expect(data.web.rqt[1000]).toEqual({ sum: 5, count: 1 })
  })

  test("dispatch dead gen on error does not repopulate without handoff", async () => {
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    dispatcher._generation = 1
    dispatcher._running = true
    dispatcher._stopping = false
    dispatcher._client.submitSamples = async () => {
      dispatcher._running = false
      throw new Error("network")
    }
    await dispatcher._dispatch(1)
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("ensure job queue loop is noop when not running", () => {
    const dispatcher = configureWebAndWorkers()
    dispatcher.ensureJobQueueLoop()
    expect(dispatcher._jobLoopPromise).toBeNull()
  })

  test("ensure job queue loop starts when enter race becomes true", async () => {
    stubLease()
    captureIngestBodies()
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(false)
    const dispatcher = config().dispatcher
    process.env.DYNO = "web.1"
    dispatcher.start()
    expect(dispatcher._jobLoopPromise).toBeNull()
    config().dyno("worker", () => 1)
    dispatcher.ensureJobQueueLoop()
    expect(dispatcher._jobLoopPromise).not.toBeNull()
    await dispatcher.stop()
  })

  test("ensure job queue loop leaves a live job loop unchanged", () => {
    const dispatcher = configureWebAndWorkers()
    const jobLoop = Promise.resolve()
    jobLoop._hirefireAlive = true
    dispatcher._running = true
    dispatcher._jobLoopPromise = jobLoop
    const enterRace = jest.spyOn(dispatcher, "_enterRace")

    dispatcher.ensureJobQueueLoop()

    expect(dispatcher._jobLoopPromise).toBe(jobLoop)
    expect(enterRace).not.toHaveBeenCalled()
  })

  test("ensure job queue loop logs when loop spawn fails", () => {
    const dispatcher = configureWebAndWorkers()
    dispatcher._running = true
    jest.spyOn(dispatcher, "_loop").mockImplementation(() => {
      throw new Error("cannot create job loop")
    })

    dispatcher.ensureJobQueueLoop()

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Could not start job-queue loop"),
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("cannot create job loop"),
    )
  })

  test("sample count limit matches metrics buffer", () => {
    expect(Dispatcher.SAMPLE_COUNT_LIMIT).toBe(MetricsBuffer.SAMPLE_COUNT_LIMIT)
  })

  test("running false when main loop dead", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    dispatcher.start()
    dispatcher._dispatchLoopPromise._hirefireAlive = false
    expect(dispatcher.running()).toBe(false)
    await dispatcher.stop()
  })

  test("start restarts when main loop is dead", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()
    expect(dispatcher.start()).toBe(true)
    const oldJob = dispatcher._jobLoopPromise
    expect(oldJob).not.toBeNull()
    expect(oldJob._hirefireAlive).toBe(true)

    dispatcher._dispatchLoopPromise._hirefireAlive = false
    expect(dispatcher.running()).toBe(false)
    expect(dispatcher.start()).toBe(true)

    expect(dispatcher._jobLoopPromise).not.toBe(oldJob)
    expect(
      dispatcher._retiredLoops.has(oldJob) || oldJob._hirefireAlive === false,
    ).toBe(true)

    await dispatcher.stop()
    expect(dispatcher._retiredLoops.size).toBe(0)
  })

  test("join clears abandon timer when the loop settles first", async () => {
    jest.useFakeTimers()
    try {
      const dispatcher = configureWebOnly()
      const warn = jest.fn()
      dispatcher._logger = () => ({ warn, info: jest.fn(), error: jest.fn() })
      dispatcher._stopJoinTimeoutMs = 5000

      let resolveLoop
      const loopPromise = new Promise((resolve) => {
        resolveLoop = resolve
      })

      const join = dispatcher._joinLoops(loopPromise)
      resolveLoop()
      await join

      await jest.advanceTimersByTimeAsync(5000)
      expect(warn).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test("join warns only when the loop exceeds join timeout", async () => {
    jest.useFakeTimers()
    try {
      const dispatcher = configureWebOnly()
      const warn = jest.fn()
      dispatcher._logger = () => ({ warn, info: jest.fn(), error: jest.fn() })
      dispatcher._stopJoinTimeoutMs = 5000

      const loopPromise = new Promise(() => {})
      const join = dispatcher._joinLoops(loopPromise)

      await jest.advanceTimersByTimeAsync(4999)
      expect(warn).not.toHaveBeenCalled()
      await jest.advanceTimersByTimeAsync(1)
      await join
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Abandoning thread"),
      )
    } finally {
      jest.useRealTimers()
    }
  })

  test("hold demotion logs and web dispatch continues", async () => {
    nock(BASE)
      .persist()
      .post("/metrics/lease")
      .reply(
        200,
        JSON.stringify({
          version: 1,
          job_queues: [
            { name: "x", strategy: "jqs", adapter: "unknown_adapter" },
          ],
        }),
        {
          "HireFire-Lease-Granted": "true",
          "HireFire-Sample-Frequency": "15",
        },
      )
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 3)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(
      logger.info.mock.calls.some((c) =>
        String(c[0]).includes("Lease grant dropped"),
      ),
    ).toBe(true)
    expect(bodies.length).toBeGreaterThan(0)
  })

  test("dispatch dead gen after flush does not repopulate when not final flush", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 10)
    dispatcher._generation = 1
    dispatcher._running = true
    dispatcher._stopping = false
    dispatcher._stoppingFlush = false
    let calls = 0
    dispatcher._loopActive = () => {
      calls += 1
      return calls === 1
    }
    await dispatcher._dispatch(1)
    expect(bodies).toEqual([])
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("dispatch dead gen after flush handoffs for final flush", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 10)
    dispatcher._generation = 1
    dispatcher._running = false
    dispatcher._stopping = true
    dispatcher._stoppingFlush = true
    let calls = 0
    dispatcher._loopActive = () => {
      calls += 1
      return calls === 1
    }
    await dispatcher._dispatch(1)
    expect(bodies).toEqual([])
    const data = config().buffer.flush()
    expect(data.web.rqt[1000]).toEqual({ sum: 10, count: 1 })
  })

  test("dispatch dead gen on error handoffs for final flush", async () => {
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 10)
    dispatcher._generation = 1
    dispatcher._running = false
    dispatcher._stopping = true
    dispatcher._stoppingFlush = true
    let calls = 0
    dispatcher._loopActive = () => {
      calls += 1
      return calls <= 2
    }
    dispatcher._client.submitSamples = async () => {
      throw new Error("network")
    }
    await dispatcher._dispatch(1)
    const data = config().buffer.flush()
    expect(data.web.rqt[1000]).toEqual({ sum: 10, count: 1 })
  })

  test("dispatch if due does not advance pacing on dead gen", async () => {
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 10)
    dispatcher._generation = 1
    dispatcher._running = true
    dispatcher._stopping = false
    dispatcher._stoppingFlush = false
    dispatcher._nextDispatchAt = null
    let calls = 0
    dispatcher._loopActive = () => {
      calls += 1
      return calls === 1
    }
    await dispatcher._dispatchIfDue(1)
    expect(dispatcher._nextDispatchAt).toBeNull()
  })

  test("ensure job queue loop is noop when stopping", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()
    dispatcher.start()
    const before = dispatcher._jobLoopPromise
    dispatcher._stopping = true
    dispatcher._jobLoopPromise = null
    dispatcher.ensureJobQueueLoop()
    expect(dispatcher._jobLoopPromise).toBeNull()
    dispatcher._stopping = false
    dispatcher._jobLoopPromise = before
    await dispatcher.stop()
  })

  test("ensure job queue loop restarts dead job queue loop", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()
    dispatcher.start()
    const dead = Promise.resolve()
    dead._hirefireAlive = false
    dispatcher._jobLoopPromise = dead
    dispatcher.ensureJobQueueLoop()
    expect(dispatcher._jobLoopPromise).not.toBe(dead)
    expect(dispatcher._jobLoopPromise).not.toBeNull()
    await dispatcher.stop()
  })

  test("start rejected while stopping", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    expect(dispatcher.start()).toBe(true)
    dispatcher._stopping = true
    expect(dispatcher.start()).toBe(false)
    dispatcher._stopping = false
    await dispatcher.stop()
  })

  test("a failed loop spawn leaves the dispatcher retryable", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    jest.spyOn(dispatcher, "_loop").mockImplementationOnce(() => {
      throw new Error("cannot spawn loop")
    })
    expect(dispatcher.start()).toBe(false)
    expect(dispatcher.running()).toBe(false)
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes("Could not start dispatcher"),
      ),
    ).toBe(true)
    expect(dispatcher.start()).toBe(true)
    expect(dispatcher.running()).toBe(true)
    await dispatcher.stop()
  })

  test("concurrent start during stop is rejected then retryable even if a starter wins after stopping clears", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    expect(dispatcher.start()).toBe(true)
    expect(dispatcher.running()).toBe(true)

    let releaseClose
    const closeGate = new Promise((resolve) => {
      releaseClose = resolve
    })
    dispatcher._client.close = async () => {
      await closeGate
    }
    dispatcher._lease.close = async () => {}

    const stopPromise = dispatcher.stop()
    await new Promise((resolve) => setImmediate(resolve))

    const results = []
    for (let i = 0; i < 8; i++) {
      results.push(dispatcher.start())
    }
    expect(results.every((r) => r === false)).toBe(true)

    releaseClose()
    await stopPromise
    expect(dispatcher.running()).toBe(false)

    expect(dispatcher.start()).toBe(true)
    expect(dispatcher.running()).toBe(true)
    await dispatcher.stop()
  })

  test("a hung worker sampler does not stall web dispatch", async () => {
    let releaseGate
    const gate = new Promise((resolve) => {
      releaseGate = resolve
    })
    let resolveWeb
    const webPosted = new Promise((resolve) => {
      resolveWeb = resolve
    })
    let resolveWorker
    const workerPosted = new Promise((resolve) => {
      resolveWorker = resolve
    })
    let workerSeen = false

    nock(BASE)
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
          "HireFire-Sample-Frequency": "1",
        },
      )
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        if (body.some((e) => e.name === "web")) resolveWeb(body)
        if (body.some((e) => e.name === "worker")) {
          workerSeen = true
          resolveWorker(body)
        }
        return [200]
      })

    config().dyno("web")
    config().dyno("worker", async () => {
      await gate
      return 0
    })
    const dispatcher = config().dispatcher
    config().buffer.sample("web", "rqt", 5)
    expect(dispatcher.start()).toBe(true)

    const webBody = await withTimeout(webPosted, 3000, "web dispatch stalled")
    expect(webBody.some((e) => e.name === "web")).toBe(true)
    expect(workerSeen).toBe(false)

    releaseGate()
    await withTimeout(workerPosted, 3000, "worker never dispatched")
    await dispatcher.stop()
  })

  test("empty plan with local samplers still holds lease", async () => {
    stubLease(true, JSON.stringify({ version: 1, job_queues: [] }))
    config().dyno("worker", () => 5)
    const dispatcher = config().dispatcher
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(true)
  })

  test("sample trace attached when grant trace true", async () => {
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        trace: true,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: null,
            queues: [],
            options: {},
          },
          {
            name: "mailer",
            strategy: "jql",
            adapter: null,
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 42)
    config().dyno("mailer", () => 18)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    expect(bodies[0][0].sample_trace).toBeTruthy()
    const entry = bodies[0][0]
    expect(entry.sample_trace.wave_ms).toEqual(expect.any(Number))
    expect(Array.isArray(entry.sample_trace.ops)).toBe(true)
    expect(entry.sample_trace.ops).toHaveLength(2)
    expect(
      entry.sample_trace.ops.every((op) => op.strategy === "jql" && "ms" in op),
    ).toBe(true)
    expect(bodies[0].slice(1).every((e) => !e.sample_trace)).toBe(true)
  })

  test("oversized sample trace is stripped so metrics still ship", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    dispatcher._lease.trace = () => true
    dispatcher._pendingSampleTrace = {
      wave_ms: 1.0,
      ops: [
        {
          adapter: "bullmq",
          strategy: "jqs",
          queues: ["q".repeat(40000)],
          options: {},
          ms: 1.0,
        },
      ],
    }
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)
    config().buffer.sample("worker", "jqs", 3)
    await dispatcher._dispatch()
    expect(bodies).toHaveLength(1)
    expect(bodies[0][0].sample_trace).toBeUndefined()
    expect(bodies[0][0].metrics.rqt).toBeTruthy()
    expect(
      bodies[0].find((entry) => entry.name === "worker").metrics.jqs,
    ).toEqual({ 1000: 3 })
    expect(
      logger.error.mock.calls.some((args) =>
        String(args[0]).includes("Dropped metrics payload"),
      ),
    ).toBe(false)
    expect(dispatcher._pendingSampleTrace).toBeNull()
  })

  test("sample trace absent without grant trace", async () => {
    stubLease(
      true,
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
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 42)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    expect(bodies[0].every((e) => !e.sample_trace)).toBe(true)
  })

  test("verbose logs sample timings without server trace", async () => {
    process.env.HIREFIRE_VERBOSE = "1"
    stubLease(
      true,
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
    )
    config().dyno("worker", () => 42)
    const dispatcher = config().dispatcher
    await dispatcher._workerTick()
    const info = logger.info.mock.calls.map((c) => c[0]).join("\n")
    expect(info).toContain("sample_job_queues wave_ms=")
    expect(info).toContain("sample adapter=")
    delete process.env.HIREFIRE_VERBOSE
  })

  test("empty string adapter uses local strategy sampler", async () => {
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jqs",
            adapter: "",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 11)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(Object.values(entry.metrics.jqs)[0]).toBe(11)
  })

  test("unsupported strategy once log is isolated per name adapter strategy", async () => {
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(false)
    jest.spyOn(Plan, "knownAdapter").mockReturnValue(true)
    const latency = jest.fn(async () => 1)
    const macro = {
      supportsPlanStrategy: () => false,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueLatency: latency,
    }
    Object.defineProperty(Plan.ADAPTERS, "bunny", {
      get: () => macro,
      configurable: true,
    })
    Object.defineProperty(Plan.ADAPTERS, "resque", {
      get: () => macro,
      configurable: true,
    })
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bunny",
            queues: [],
            options: {},
          },
          {
            name: "mailer",
            strategy: "jql",
            adapter: "bunny",
            queues: [],
            options: {},
          },
          {
            name: "worker",
            strategy: "jql",
            adapter: "resque",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    config().dyno("other", () => 0)
    const dispatcher = config().dispatcher
    await dispatcher._workerTick()
    await dispatcher._workerTick()

    const msgs = logger.error.mock.calls.map((c) => String(c[0]))
    expect(msgs.filter((m) => m.includes("does not support")).length).toBe(3)
    const warned = dispatcher._unsupportedStrategyWarned
    expect(warned["worker\0bunny\0jql"]).toBe(true)
    expect(warned["mailer\0bunny\0jql"]).toBe(true)
    expect(warned["worker\0resque\0jql"]).toBe(true)
  })

  test("stop closes transports even when final dispatch raises", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    dispatcher._running = true
    dispatcher._dispatchLoopPromise = null
    dispatcher._jobLoopPromise = null
    dispatcher._dispatch = async () => {
      throw new Error("flush failed")
    }
    const clientClose = jest.spyOn(dispatcher._client, "close")
    const leaseDemote = jest.spyOn(dispatcher._lease, "demote")
    const leaseClose = jest.spyOn(dispatcher._lease, "close")
    await expect(dispatcher.stop()).rejects.toThrow("flush failed")
    expect(clientClose).toHaveBeenCalled()
    expect(leaseDemote).toHaveBeenCalled()
    expect(leaseClose).toHaveBeenCalled()
    expect(dispatcher._stopping).toBe(false)
  })

  test("stop logs transport close failures", async () => {
    const dispatcher = configureWebOnly()
    dispatcher._client.close = jest
      .fn()
      .mockRejectedValue(new Error("client close failed"))
    dispatcher._lease.close = jest
      .fn()
      .mockRejectedValue(new Error("lease close failed"))

    await expect(dispatcher.stop()).resolves.toBe(false)

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Client close error: client close failed"),
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Lease close error: lease close failed"),
    )
  })

  test("logs an unexpected dispatcher loop failure", async () => {
    const dispatcher = configureWebOnly()
    dispatcher._runLoop = jest.fn().mockRejectedValue(new Error("loop failure"))

    const loop = dispatcher._loop(1, jest.fn())
    await loop

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Dispatcher loop stopped unexpectedly"),
    )
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("loop failure"),
    )
    expect(loop._hirefireAlive).toBe(false)
  })

  test("dispatch dead gen after successful post skips watermark and frequency", async () => {
    nock(BASE)
      .post("/metrics/ingest")
      .reply(200, "", { "HireFire-Dispatch-Frequency": "10" })
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    dispatcher._generation = 1
    dispatcher._running = true
    dispatcher._dispatchFrequency = 1
    dispatcher._lastRqtSecond = 999
    const origSubmit = dispatcher._client.submitSamples.bind(dispatcher._client)
    dispatcher._client.submitSamples = async (body) => {
      dispatcher._running = false
      return origSubmit(body)
    }
    await dispatcher._dispatch(1)
    expect(dispatcher._lastRqtSecond).toBe(999)
    expect(dispatcher._dispatchFrequency).toBe(1)
  })

  test("plan adapter overrides local sampler", async () => {
    const sample = jest.fn(async () => 9.9)
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
    jest.spyOn(Plan, "knownAdapter").mockReturnValue(true)
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueLatency: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: ["default"],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 1)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(entry.metrics.jql).toBeDefined()
    expect(Object.values(entry.metrics.jql)[0]).toBe(9.9)
  })

  test("plan override warns once", async () => {
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
    jest.spyOn(Plan, "knownAdapter").mockReturnValue(true)
    jest.spyOn(Plan, "execute").mockResolvedValue(undefined)
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    config().dyno("worker", () => 99)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._workerTick()
    const msgs = logger.warn.mock.calls.map((c) => String(c[0]))
    const hits = msgs.filter((m) => m.includes("UI adapter is configured"))
    expect(hits.length).toBe(1)
    expect(hits[0]).toMatch(/config\.dyno/)
    expect(hits[0]).toMatch(/You can remove/)
  })

  test("strategy only plan reports lease name not local dyno spelling", async () => {
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jqs",
            adapter: null,
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("Worker", () => 7)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    const names = bodies[0].map((e) => e.name)
    expect(names).toContain("worker")
    expect(names).not.toContain("Worker")
  })

  test("strategy only plan uses local sampler", async () => {
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jqs",
            adapter: null,
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 7)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(Object.values(entry.metrics.jqs)[0]).toBe(7)
    expect(
      logger.warn.mock.calls.some((c) =>
        String(c[0]).includes("UI adapter is configured"),
      ),
    ).toBe(false)
  })

  test("unknown plan adapter skips without local fallback", async () => {
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "nope",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 42)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    expect(bodies).toEqual([])
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes("Unknown plan adapter"),
      ),
    ).toBe(true)
  })

  test("known unloaded adapter skips without local fallback", async () => {
    jest.spyOn(Plan, "executable").mockReturnValue(false)
    jest.spyOn(Plan, "knownAdapter").mockReturnValue(true)
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 42)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    expect(bodies).toEqual([])
    const msgs = logger.error.mock.calls.map((c) => String(c[0]))
    expect(
      msgs.filter((m) => m.includes("is not loaded in this process")).length,
    ).toBe(1)
  })

  test("executable plan without local dyno holds lease and samples", async () => {
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(true)
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
    const sample = jest.fn(async () => 4.2)
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueLatency: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: ["default"],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    expect(dispatcher._enterRace()).toBe(true)
    expect(config().jobQueues.any()).toBe(false)
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(true)
    await dispatcher._dispatch()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(Object.values(entry.metrics.jql)[0]).toBe(4.2)
  })

  test("hold lease false when only unsupported strategy entries", async () => {
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(true)
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(false)
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: ["default"],
            options: {},
          },
        ],
      }),
    )
    const dispatcher = config().dispatcher
    expect(dispatcher._enterRace()).toBe(true)
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(false)
  })

  test("always lease non renew when no workers and no executable plan", async () => {
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(true)
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "nope",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const dispatcher = config().dispatcher
    expect(dispatcher._enterRace()).toBe(true)
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(false)
  })

  test("partial plan holds and samples only executable entries", async () => {
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(true)
    jest.spyOn(Plan, "executable").mockImplementation((a) => a === "bullmq")
    jest
      .spyOn(Plan, "knownAdapter")
      .mockImplementation((a) => ["bullmq", "other"].includes(String(a)))
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
    const sample = jest.fn(async () => 2.5)
    const macro = {
      supportsPlanStrategy: () => true,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueLatency: sample,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: ["default"],
          },
          {
            name: "mailer",
            strategy: "jql",
            adapter: "other",
            queues: ["mail"],
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(true)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    const names = bodies[0].map((e) => e.name)
    expect(names).toContain("worker")
    expect(names).not.toContain("mailer")
    const msgs = logger.error.mock.calls.map((c) => String(c[0]))
    expect(
      msgs.filter((m) => m.includes("is not loaded in this process")).length,
    ).toBe(1)
  })

  test("partial plan unsupported jql and supported jqs holds and samples size", async () => {
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(true)
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest
      .spyOn(Plan, "supportsStrategy")
      .mockImplementation((_a, strategy) => strategy === "jqs")
    const size = jest.fn(async () => 7)
    const latency = jest.fn(async () => {
      throw new Error("jql must not run")
    })
    const macro = {
      supportsPlanStrategy: (s) => s === "jqs",
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueSize: size,
      jobQueueLatency: latency,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: ["default"],
          },
          {
            name: "worker",
            strategy: "jqs",
            adapter: "bullmq",
            queues: ["default"],
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(true)
    await dispatcher._dispatch()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(entry.metrics.jqs).toBeDefined()
    expect(entry.metrics.jql).toBeUndefined()
    expect(latency).not.toHaveBeenCalled()
  })

  test("unsupported plan strategy logs once and skips macro", async () => {
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(false)
    const latency = jest.fn(async () => 1)
    const macro = {
      supportsPlanStrategy: () => false,
      planOptions: () => ({}),
      planConnectionOptions: () => ({}),
      jobQueueLatency: latency,
    }
    Object.defineProperty(Plan.ADAPTERS, "bullmq", {
      get: () => macro,
      configurable: true,
    })
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: "bullmq",
            queues: ["default"],
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("other", () => 0)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    expect(latency).not.toHaveBeenCalled()
    const msgs = logger.error.mock.calls.map((c) => String(c[0]))
    expect(msgs.filter((m) => m.includes("does not support")).length).toBe(1)
    expect(bodies.every((b) => !b.some((e) => e.name === "worker"))).toBe(true)
  })

  test("encode omits non finite rqt mean", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    const buffer = config().buffer
    buffer._metrics.web = {
      rqt: {
        1000: { sum: Infinity, count: 1 },
        999: { sum: 10, count: 1 },
      },
    }
    await dispatcher._dispatchTick()
    expect(bodies.length).toBeGreaterThan(0)
    const rqt = bodies[0][0].metrics.rqt
    expect(rqt["1000"]).toBeUndefined()
    expect(rqt["999"]).toEqual([10, 1])
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes("Omitting rqt"),
      ),
    ).toBe(true)
  })

  test("encode omits invalid non rqt values", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    config().dyno("worker", () => 1)
    freezeTime(1000)
    const limit = Dispatcher.METRIC_VALUE_LIMIT
    const buffer = config().buffer
    buffer._metrics.worker = {
      jql: {
        1000: NaN,
        999: Infinity,
        998: -1,
        997: limit + 1,
        996: "nope",
        995: 4.5,
      },
      cpu: { 1000: -0.1, 999: 12 },
    }
    buffer._metrics.web = { rqt: { 1000: { sum: 1, count: 1 } } }
    await dispatcher._dispatchTick()
    expect(bodies.length).toBeGreaterThan(0)
    const worker = bodies[0].find((e) => e.name === "worker")
    const jql = worker.metrics.jql || {}
    const cpu = worker.metrics.cpu || {}
    expect(jql["1000"]).toBeUndefined()
    expect(jql["999"]).toBeUndefined()
    expect(jql["998"]).toBeUndefined()
    expect(jql["997"]).toBeUndefined()
    expect(jql["996"]).toBeUndefined()
    expect(jql["995"]).toBe(4.5)
    expect(cpu["1000"]).toBeUndefined()
    expect(cpu["999"]).toBe(12)
  })

  test("413 advances watermark without repopulate", async () => {
    nock(BASE).post("/metrics/ingest").reply(413)
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await dispatcher._dispatch()
    expect(dispatcher._lastRqtSecond).toBe(1000)
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("oversized drop advances the watermark past the hole", async () => {
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    injectOversizedSeries()
    await dispatcher._dispatch()
    expect(dispatcher._lastRqtSecond).toBe(1000)
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("sample job queues runs plan samples inside around job queue sample", async () => {
    const order = []
    const around = jest
      .spyOn(Plan, "aroundJobQueueSample")
      .mockImplementation(async (fn, configuration) => {
        order.push("around-enter")
        expect(configuration).toBe(config())
        const result = await fn()
        order.push("around-exit")
        return result
      })
    const execute = jest
      .spyOn(Plan, "execute")
      .mockImplementation(async (entry, configuration) => {
        order.push("execute")
        expect(configuration).toBe(config())
        expect(entry).toEqual(
          expect.objectContaining({
            adapter: expect.stringMatching(/^(bullmq|bull)$/),
            strategy: "jqs",
          }),
        )
      })
    const executable = jest.spyOn(Plan, "executable").mockReturnValue(true)
    const supportsStrategy = jest
      .spyOn(Plan, "supportsStrategy")
      .mockReturnValue(true)
    const knownAdapter = jest.spyOn(Plan, "knownAdapter").mockReturnValue(true)

    const dispatcher = config().dispatcher
    dispatcher._lease._granted = true
    dispatcher._lease._jobQueues = [
      {
        name: "worker",
        adapter: "bullmq",
        strategy: "jqs",
        queues: ["default"],
      },
      {
        name: "mailer",
        adapter: "bull",
        strategy: "jqs",
        queues: ["mail"],
      },
    ]

    try {
      await dispatcher._sampleJobQueues()

      expect(around).toHaveBeenCalledTimes(1)
      expect(execute).toHaveBeenCalledTimes(2)
      expect(execute).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          name: "worker",
          adapter: "bullmq",
          strategy: "jqs",
        }),
        config(),
        undefined,
      )
      expect(execute).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          name: "mailer",
          adapter: "bull",
          strategy: "jqs",
        }),
        config(),
        undefined,
      )
      expect(order).toEqual([
        "around-enter",
        "execute",
        "execute",
        "around-exit",
      ])
    } finally {
      around.mockRestore()
      execute.mockRestore()
      executable.mockRestore()
      supportsStrategy.mockRestore()
      knownAdapter.mockRestore()
    }
  })

  test("backfills seconds skipped between dispatches", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1003)
    await dispatcher._dispatchTick()
    expect(bodies[1][0].metrics.rqt).toEqual({
      1001: [],
      1002: [],
      1003: [],
    })
  })

  test("backfill preserves buffered samples", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1003)
    config().buffer.sample("web", "rqt", 5)
    await dispatcher._dispatchTick()
    expect(bodies[1][0].metrics.rqt).toEqual({
      1001: [],
      1002: [],
      1003: [5, 1],
    })
  })

  test("seconds from a failed dispatch are reclaimed by the next success", async () => {
    let calls = 0
    const bodies = []
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        calls += 1
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
    const keys = Object.keys(bodies[2][0].metrics.rqt).sort()
    expect(keys).toEqual(["1001", "1002", "1003", "1004", "1005"])
  })

  test("backfill is capped at the limit", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1100)
    await dispatcher._dispatchTick()
    const keys = Object.keys(bodies[1][0].metrics.rqt).map(Number)
    expect(Math.min(...keys)).toBe(1100 - Dispatcher.RQT_BACKFILL_LIMIT)
    expect(Math.max(...keys)).toBe(1100)
    expect(keys.length).toBe(Dispatcher.RQT_BACKFILL_LIMIT + 1)
  })

  test("lease unauthorized does not log error", async () => {
    nock(BASE).persist().post("/metrics/lease").reply(401)
    const bodies = captureIngestBodies()
    const dispatcher = configureWorkersOnly()
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
    expect(loggerErrors()).not.toMatch(/\b401\b/)
  })

  test("web buffer discarded on unauthorized", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(401)
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)
    await dispatcher._dispatchTick()
    expect(config().buffer.flush().web).toBeUndefined()
    expect(dispatcher._lastRqtSecond).toBe(1000)
    expect(loggerErrors()).not.toContain("Dispatch error")
  })

  test("an oversized payload without web data drops without touching the watermark", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    injectOversizedSeries("worker", "jql")
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
    expect(loggerErrors()).toContain("Dropped metrics payload")
    expect(dispatcher._lastRqtSecond).toBeNull()
  })

  test("dispatch tick does not run job queue sampling", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    let sampled = false
    process.env.DYNO = "web.1"
    config().dyno("worker", () => {
      sampled = true
      return 42
    })
    const dispatcher = config().dispatcher
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await dispatcher._dispatchTick()
    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
    expect(sampled).toBe(false)
  })

  test("job queue tick samples without dispatching and a later tick delivers it", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 42)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    expect(bodies).toEqual([])
    await dispatcher._dispatchTick()
    expect(bodies.length).toBe(1)
    expect(
      bodies[0].some((e) => e.name === "worker" && e.metrics && e.metrics.jql),
    ).toBe(true)
  })

  test("combined web and worker dispatch", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    freezeTime(1000)
    const dispatcher = configureWebAndWorkers()
    config().buffer.sample("web", "rqt", 5)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    const entries = bodies[0]
    expect(
      entries.some((e) => e.name === "web" && e.metrics && e.metrics.rqt),
    ).toBe(true)
    expect(
      entries.some((e) => e.name === "worker" && e.metrics && e.metrics.jql),
    ).toBe(true)
  })

  test("lease granted dispatches workers", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    const dispatcher = configureWorkersOnly()
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(
      bodies[0].some((e) => e.name === "worker" && e.metrics && e.metrics.jql),
    ).toBe(true)
  })

  test("lease denied skips worker collection", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const dispatcher = configureWorkersOnly()
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
  })

  test("cpu first tick seeds baseline without dispatching", async () => {
    const bodies = captureIngestBodies()
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 0.0, source: "cgroupV2" })
    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
  })

  test("cpu samples are not repopulated on dispatch failure", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce({ seconds: 0.0, source: "cgroupV2" })
      .mockReturnValue({ seconds: 0.5, source: "cgroupV2" })
    const dispatcher = configureCpuOnly("clock")
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1001)
    await dispatcher._dispatchTick()
    const data = config().buffer.flush()
    expect(data.clock && data.clock.cpu).toBeUndefined()
  })

  test("non web process does not heartbeat the web name", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "worker.1"
    config().dyno("web")
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
  })

  test("non web process still delivers real web samples", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "worker.1"
    config().dyno("web")
    const dispatcher = config().dispatcher
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 12)
    await dispatcher._dispatchTick()
    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [12, 1] })
  })

  test("matching identity keeps heartbeat and backfill", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().dyno("web")
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1002)
    await dispatcher._dispatchTick()
    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [] })
    expect(bodies[1][0].metrics.rqt).toEqual({ 1001: [], 1002: [] })
  })

  test("tick dispatches when the lease request fails", async () => {
    nock(BASE).persist().post("/metrics/lease").replyWithError({
      code: "ECONNREFUSED",
    })
    const bodies = captureIngestBodies()
    freezeTime(1000)
    const dispatcher = configureWebAndWorkers()
    config().buffer.sample("web", "rqt", 12)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(bodies.length).toBe(1)
    expect(loggerErrors()).toMatch(/Network error|ECONNREFUSED|Error/)
  })

  test("tick dispatches when a sampler raises", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().dyno("worker", () => {
      throw new Error("Redis down")
    })
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(bodies.length).toBe(1)
    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
    expect(loggerErrors()).toContain("Redis down")
  })

  test("web only dispatch never requests a lease", async () => {
    const lease = nock(BASE).post("/metrics/lease").reply(200)
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    expect(lease.isDone()).toBe(false)
  })

  test("no dispatch when nothing configured", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    await config().dispatcher._dispatchTick()
    expect(bodies).toEqual([])
  })

  test("dispatch frequency defaults to one without the header", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1001)
    await dispatcher._dispatchTick()
    expect(bodies.length).toBe(2)
  })

  test("honors a server supplied dispatch frequency", async () => {
    let posts = 0
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(function () {
        posts += 1
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
    expect(posts).toBe(2)
    expect(dispatcher._dispatchFrequency).toBe(5)
  })

  test("clamps an over large dispatch frequency to the maximum", async () => {
    stubIngestWithDispatchFrequency(Dispatcher.MAX_DISPATCH_FREQUENCY + 100)
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    await dispatcher._dispatchTick()
    expect(dispatcher._dispatchFrequency).toBe(
      Dispatcher.MAX_DISPATCH_FREQUENCY,
    )
  })

  test("ignores a non positive dispatch frequency", async () => {
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

  test("dispatch failure without web data does not repopulate", async () => {
    stubGrantedLease()
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    const dispatcher = configureWorkersOnly()
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(config().buffer.flush().web).toBeUndefined()
    expect(loggerErrors()).toContain("Dispatch error")
  })

  test("tick survives a payload build error", async () => {
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)
    jest.spyOn(dispatcher, "_buildPayload").mockImplementation(() => {
      throw new Error("boom")
    })
    await dispatcher._dispatchTick()
    expect(loggerErrors()).toContain("Dispatch error")
    expect(config().buffer.flush().web.rqt[1000]).toEqual({ sum: 7, count: 1 })
  })

  test("dispatch pacing follows the monotonic clock not the wall clock", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    jest.spyOn(Date, "now").mockReturnValue(1000 * 1000)
    let mono = 500000
    jest.spyOn(performance, "now").mockImplementation(() => mono)
    await dispatcher._dispatchTick()
    mono = 502000
    await dispatcher._dispatchTick()
    expect(bodies.length).toBe(2)
  })

  test("nested payload merges rqt and cpu under one name", async () => {
    process.env.DYNO = "web.1"
    const bodies = captureIngestBodies()
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce({ seconds: 0.0, source: "cgroupV2" })
      .mockReturnValue({ seconds: 0.5, source: "cgroupV2" })
    config().dyno("web")
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._dispatchTick()
    freezeTime(1001)
    config().buffer.sample("web", "rqt", 12)
    await dispatcher._dispatchTick()
    const entry = bodies[bodies.length - 1].find((e) => e.name === "web")
    expect(entry.metrics.rqt).toBeDefined()
    expect(entry.metrics.cpu).toBeDefined()
  })

  test("jql not repopulated on dispatch failure", async () => {
    stubGrantedLease()
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    freezeTime(1000)
    config().dyno("worker", () => 3)
    const dispatcher = config().dispatcher
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
    expect(loggerErrors()).toContain("Dispatch error")
  })

  test("hold lease true when only supported plan entries without local dynos", () => {
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
    const dispatcher = config().dispatcher
    expect(
      dispatcher._holdLease([
        {
          name: "worker",
          strategy: "jqs",
          adapter: "bullmq",
          queues: ["default"],
        },
      ]),
    ).toBe(true)
  })

  test("sample plan adapter skips queues required empty lists", async () => {
    const execute = jest.spyOn(Plan, "execute")
    jest.spyOn(Plan, "executable").mockReturnValue(true)
    jest.spyOn(Plan, "supportsStrategy").mockReturnValue(true)
    jest.spyOn(Plan, "queuesRequired").mockReturnValue(true)
    jest.spyOn(Plan, "namedPlanQueues").mockReturnValue(false)
    const dispatcher = config().dispatcher
    await dispatcher._samplePlanAdapter(
      { name: "mail", adapter: "bunny", strategy: "jqs", queues: [] },
      config().jobQueues,
    )
    expect(execute).not.toHaveBeenCalled()
    expect(loggerErrors()).toMatch(/requires named queues/)
  })

  test("strategy only unknown strategy skips and logs", async () => {
    stubGrantedLease(
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "rpm",
            adapter: null,
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 7)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
    expect(loggerErrors()).toContain("Unknown plan strategy")
  })

  test("wire payload nested multi strategy shape", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    freezeTime(1000)
    config().dyno("web")
    config().dyno("worker", () => 3)
    const dispatcher = config().dispatcher
    config().buffer.sample("web", "rqt", 12)
    config().buffer.sample("web", "cpu", 25.0)
    await dispatcher._workerTick()
    await dispatcher._dispatchTick()
    const payload = bodies[0]
    const web = payload.find((e) => e.name === "web")
    const worker = payload.find((e) => e.name === "worker")
    expect(web.metrics.rqt).toEqual({ 1000: [12, 1] })
    expect(web.metrics.cpu).toEqual({ 1000: 25.0 })
    expect(worker.metrics.jql).toBeDefined()
    for (const entry of payload) {
      expect(Object.keys(entry).sort()).toEqual(["metrics", "name"])
    }
  })

  test("ensure job queue loop is noop without enter race", async () => {
    jest
      .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
      .mockReturnValue(false)
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebOnly()
    dispatcher.start()
    expect(dispatcher._jobLoopPromise).toBeNull()
    dispatcher.ensureJobQueueLoop()
    expect(dispatcher._jobLoopPromise).toBeNull()
    await dispatcher.stop()
  })
})

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => {
      if (timer != null) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
      if (timer.unref) timer.unref()
    }),
  ])
}
