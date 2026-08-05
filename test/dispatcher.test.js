const { freezeTime } = require("./support")
const nock = require("nock")
const HireFire = require("../src")
const Dispatcher = require("../src/dispatcher")
const MetricsBuffer = require("../src/buffer")
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

  function stubLease(granted = false, body = "") {
    nock(BASE)
      .persist()
      .post("/metrics/lease")
      .reply(200, body, {
        "HireFire-Lease-Granted": String(granted),
        "HireFire-Sample-Frequency": "15",
      })
  }

  function injectOversizedSeries() {
    const buffer = config().buffer
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 400; i++) {
      const processName = `p${i}-${"x".repeat(48)}`
      const series = {}
      for (let s = 0; s < 60; s++) {
        series[now - s] = { sum: 1, count: 1 }
      }
      buffer._metrics[processName] = { rqt: series }
    }
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

  test("vector C encode mean and count", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 20)
    config().buffer.sample("web", "rqt", 20)
    config().buffer.sample("web", "rqt", 20)
    await dispatcher._dispatch()
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([20, 3])
  })

  test("encode clamps n to SAMPLE_COUNT_LIMIT", () => {
    const dispatcher = configureWebOnly()
    const leaf = dispatcher._encodeLeaf("rqt", {
      sum: Dispatcher.SAMPLE_COUNT_LIMIT * 2,
      count: Dispatcher.SAMPLE_COUNT_LIMIT + 5,
    })
    expect(leaf[1]).toBe(Dispatcher.SAMPLE_COUNT_LIMIT)
    expect(Number.isInteger(leaf[1])).toBe(true)
  })

  test("oversized payload drops without post", async () => {
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

  test("logs the payload when HIREFIRE_VERBOSE is set", async () => {
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
    process.env.DYNO = "web.1"
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()

    freezeTime(1000)
    await dispatcher._dispatchTick()

    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [] })
  })

  test("unresolved identity does not synthesize heartbeats", async () => {
    const bodies = captureIngestBodies()
    config().dyno("web")
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._dispatchTick()
    expect(bodies).toEqual([])
  })

  test("always on cpu tick under identity name", async () => {
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

  test("stop without flush discards buffer", async () => {
    stubLease()
    const dispatcher = configureWebOnly()
    dispatcher.start()
    config().buffer.sample("web", "rqt", 9)
    await dispatcher.stop({ flush: false })
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("stop with flush sends final dispatch", async () => {
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

  test("stale generation does not post", async () => {
    const bodies = captureIngestBodies()
    const dispatcher = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    dispatcher._generation = 1
    await dispatcher._dispatch(0)
    expect(bodies).toEqual([])
  })

  test("dead gen after successful post skips watermark", async () => {
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

  test("error path repopulates when live", async () => {
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

  test("error path no repopulate when dead without handoff", async () => {
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

  test("ensure job queue loop noops when not running", () => {
    const dispatcher = configureWebAndWorkers()
    dispatcher.ensureJobQueueLoop()
    expect(dispatcher._jobLoopPromise).toBeNull()
  })

  test("ensure job queue loop starts when running and enter race", async () => {
    stubLease()
    captureIngestBodies()
    jest
      .spyOn(require("../src/plan"), "anyAllowlistedJobQueueLibraryLoaded")
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

  test("plan strategy only local sample", async () => {
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: [{ name: "worker", strategy: "jqs" }],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 11)
    const dispatcher = config().dispatcher
    freezeTime(1000)
    await dispatcher._workerTick()
    await dispatcher._dispatch()
    const entry = bodies.find((b) => b.some((e) => e.metrics && e.metrics.jqs))
    expect(entry).toBeDefined()
  })

  test("SAMPLE_COUNT_LIMIT matches MetricsBuffer", () => {
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

  test("dead main start retires live job loop for join", async () => {
    stubLease()
    captureIngestBodies()
    const dispatcher = configureWebAndWorkers()
    expect(dispatcher.start()).toBe(true)
    const oldJob = dispatcher._jobLoopPromise
    expect(oldJob).not.toBeNull()
    expect(oldJob._hirefireAlive).toBe(true)

    // Latch running with a dead main loop while the job loop is still live.
    dispatcher._dispatchLoopPromise._hirefireAlive = false
    expect(dispatcher.running()).toBe(false)
    expect(dispatcher.start()).toBe(true)

    expect(dispatcher._jobLoopPromise).not.toBe(oldJob)
    // Retired promise is tracked until joined (or already cleared if it exited).
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

  test("join warns only when the loop exceeds JOIN_TIMEOUT", async () => {
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

  test("dispatch dead gen after flush does not repopulate without handoff", async () => {
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

  test("dispatchIfDue does not advance pacing on dead gen", async () => {
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

  test("ensureJobQueueLoop noops when stopping", async () => {
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

  test("ensureJobQueueLoop restarts dead job loop", async () => {
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

  test("a failed start leaves the dispatcher retryable", async () => {
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

  test("concurrent start during stop is rejected then retryable", async () => {
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

  test("hung worker sampler does not stall web dispatch", async () => {
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

  test("unsupported strategy once-log is isolated per name adapter strategy", async () => {
    const Plan = require("../src/plan")
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
    dispatcher._pid = process.pid
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

  test("dead gen after successful post skips frequency apply", async () => {
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
    const Plan = require("../src/plan")
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
    const Plan = require("../src/plan")
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
    const Plan = require("../src/plan")
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
    expect(config().workers.any()).toBe(false)
    await dispatcher._workerTick()
    expect(dispatcher._lease.granted()).toBe(true)
    await dispatcher._dispatch()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(Object.values(entry.metrics.jql)[0]).toBe(4.2)
  })

  test("hold lease false when only unsupported strategy entries", async () => {
    const Plan = require("../src/plan")
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

  test("always lease non-renew when no workers and no executable plan", async () => {
    const Plan = require("../src/plan")
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
    const Plan = require("../src/plan")
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
    const Plan = require("../src/plan")
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
    const Plan = require("../src/plan")
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

  test("encode omits non-finite rqt mean", async () => {
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

  test("encode omits invalid non-rqt values", async () => {
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

  test("oversized drop advances watermark past the hole", async () => {
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const dispatcher = config().dispatcher
    freezeTime(1000)
    injectOversizedSeries()
    await dispatcher._dispatch()
    expect(dispatcher._lastRqtSecond).toBe(1000)
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
  })

  test("sampleJobQueues runs plan samples inside aroundJobQueueSample", async () => {
    const Plan = require("../src/plan")
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
      )
      expect(execute).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          name: "mailer",
          adapter: "bull",
          strategy: "jqs",
        }),
        config(),
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
})

function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise.finally(() => {
      if (timer != null) clearTimeout(timer)
    }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms)
    }),
  ])
}
