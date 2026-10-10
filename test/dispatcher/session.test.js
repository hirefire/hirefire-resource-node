const { freezeTime } = require("../support")
const nock = require("nock")
const HireFire = require("../../src")
const Session = require("../../src/dispatcher/session")
const Lease = require("../../src/lease")
const Once = require("../../src/once")
const Payload = require("../../src/dispatcher/payload")
const Usage = require("../../src/source/cpu/usage")

const BASE = "https://data.hirefire.io"

describe("Session", () => {
  let logger

  beforeEach(() => {
    process.env.HIREFIRE_TOKEN = "test-token-value"
    logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    HireFire.configuration.logger = logger
  })

  function config() {
    return HireFire.configuration
  }

  async function jobQueuePass(session) {
    await session.renew()
    await session.sample()
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
    buffer.sample("x".repeat(Session.PAYLOAD_SIZE_LIMIT), strategy, 1)
    buffer.sample(name, strategy, 1)
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
    return new Session(config())
  }

  function configureWebOnly() {
    process.env.DYNO = "web.1"
    return new Session(config())
  }

  function configureWorkersOnly() {
    config().dyno("worker", () => 42)
    config().dyno("mailer", () => 18)
    return new Session(config())
  }

  function configureCpuOnly(name = "clock") {
    process.env.HIREFIRE_SERVICE_NAME = name
    return new Session(config())
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

  function captureIngestBodiesWithDispatchFrequency(value) {
    const bodies = []
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(function (uri, body) {
        bodies.push(body)
        return [200, "", { "HireFire-Dispatch-Frequency": String(value) }]
      })
    return bodies
  }

  function loggerErrors() {
    return logger.error.mock.calls.map((c) => String(c[0])).join("\n")
  }

  test("dispatches web metrics", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()

    freezeTime(1000)
    config().buffer.sample("web", "rqt", 12)
    config().buffer.sample("web", "rqt", 8)
    await session.report()

    expect(bodies[0][0].name).toBe("web")
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([10, 2])
  })

  test("dispatches jqs and wrk as sibling bare numbers", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const session = configureWebAndWorkers()

    freezeTime(2500)
    config().buffer.sample("worker", "jqs", 12)
    config().buffer.sample("worker", "wrk", 3)
    await session.report()

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
    const session = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 20)
    config().buffer.sample("web", "rqt", 20)
    config().buffer.sample("web", "rqt", 20)
    await session.flush()
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([20, 3])
  })

  test("oversized payload is dropped without a request", async () => {
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const bodies = captureIngestBodies()
    const session = new Session(config())

    freezeTime(1000)
    injectOversizedSeries()
    await session.flush()
    expect(bodies).toEqual([])
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes("Dropped metrics payload"),
      ),
    ).toBe(true)
  })

  test("a payload of exactly 131072 bytes is sent and one byte more is dropped", async () => {
    const limit = Session.PAYLOAD_SIZE_LIMIT
    expect(limit).toBe(131072)
    const bodies = captureIngestBodies()
    const session = new Session(config())
    const empty = JSON.stringify([{ name: "", metrics: { jqs: { 1000: 1 } } }])
    const name = "n".repeat(limit - Buffer.byteLength(empty))

    freezeTime(1000)
    config().buffer.sample(name, "jqs", 1)
    await session.flush()
    expect(bodies.map((body) => JSON.stringify(body).length)).toEqual([limit])
    expect(logger.error).not.toHaveBeenCalled()

    config().buffer.sample(`${name}n`, "jqs", 1)
    await session.flush()
    expect(bodies).toHaveLength(1)
    expect(logger.error.mock.calls).toEqual([
      [
        `[HireFire] Dropped metrics payload: ${
          limit + 1
        } bytes exceeds the ${limit}-byte limit. Resuming from the current second.`,
      ],
    ])
  })

  test("seven sample waves of a full plan with the longest names ship in one payload", async () => {
    const bodies = captureIngestBodies()
    const session = new Session(config())
    const names = Array.from({ length: Lease.MAX_JOB_QUEUES }, (_, i) =>
      `worker_${String(i).padStart(3, "0")}`.padEnd(128, "x"),
    )

    for (const second of [1000, 1005, 1010, 1015, 1020, 1025, 1030]) {
      freezeTime(second)
      for (const name of names) {
        config().buffer.sample(name, "jqs", 1234)
        config().buffer.sample(name, "wrk", 12)
      }
    }
    await session.flush()

    expect(bodies).toHaveLength(1)
    expect(bodies[0].map((entry) => entry.name)).toEqual(names)
    expect(
      bodies[0].every((entry) =>
        Object.values(entry.metrics).every(
          (series) => Object.keys(series).length === 7,
        ),
      ),
    ).toBe(true)
    expect(JSON.stringify(bodies[0]).length).toBeGreaterThan(65536)
    expect(logger.error).not.toHaveBeenCalled()
  })

  test("logs the payload when verbose is set", async () => {
    process.env.HIREFIRE_VERBOSE = "1"
    captureIngestBodies()
    const session = configureWebOnly()

    freezeTime(1000)
    config().buffer.sample("web", "rqt", 12)
    await session.report()

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Dispatching metrics"),
    )
  })

  test("first dispatch claims only the current second", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()

    freezeTime(1000)
    await session.report()

    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [] })
  })

  test("unresolved identity does not synthesize liveness", async () => {
    const bodies = captureIngestBodies()
    config().dyno("web")
    const session = new Session(config())
    freezeTime(1000)
    await session.report()
    expect(bodies).toEqual([])
  })

  test("always on cpu uses identity name through the tick", async () => {
    process.env.DYNO = "worker.1"
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 1.0, source: "process" })
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    const bodies = captureIngestBodies()
    const session = new Session(config())

    freezeTime(1000)
    await session.report()
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 1.5, source: "process" })
    freezeTime(1001)
    await session.report()

    const cpuEntry = bodies.find((b) => b.some((e) => e.name === "worker"))
    expect(cpuEntry).toBeDefined()
  })

  test("always on rqt under dyno web without declaration", async () => {
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const bodies = captureIngestBodies()
    const session = new Session(config())
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await session.report()
    expect(bodies[0][0].name).toBe("web")
    expect(Object.values(bodies[0][0].metrics.rqt)[0]).toEqual([5, 1])
  })

  test("web buffer repopulated on dispatch failure", async () => {
    nock(BASE).post("/metrics/ingest").replyWithError({ code: "ECONNREFUSED" })
    const session = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await session.report()
    const data = config().buffer.flush()
    expect(data.web.rqt[1000]).toEqual({ sum: 5, count: 1 })
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
    const session = new Session(config())
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 3)
    await jobQueuePass(session)
    await session.report()
    freezeTime(1020)
    await jobQueuePass(session)
    expect(
      logger.info.mock.calls.filter((c) =>
        String(c[0]).includes("Lease grant dropped"),
      ),
    ).toHaveLength(1)
    expect(nock.isDone()).toBe(true)
    expect(bodies.length).toBeGreaterThan(0)
  })

  test("nothing is sent when nothing is configured", async () => {
    const bodies = captureIngestBodies()
    await new Session(config()).report()
    expect(bodies).toEqual([])
  })

  test("a pass goes on when the buffer cannot be read, and logs it", async () => {
    captureIngestBodies()
    const session = configureWebOnly()
    jest.spyOn(config().buffer, "flush").mockImplementationOnce(() => {
      throw new Error("boom")
    })

    await session.report()

    expect(logger.error.mock.calls).toEqual([
      ["[HireFire] Dispatch error: Error: boom"],
    ])
  })

  test("a pass goes on when the CPU cannot be read, and logs it", async () => {
    const bodies = captureIngestBodies()
    jest.spyOn(Usage, "reading").mockImplementation(() => {
      throw new Error("boom")
    })
    const session = configureWebOnly()

    freezeTime(1000)
    await session.report()

    expect(logger.error.mock.calls).toEqual([["[HireFire] Error: boom"]])
    expect(bodies).toHaveLength(1)
  })

  test("a payload that cannot be built keeps its request queue time and logs it", async () => {
    captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)
    Object.defineProperty(config(), "httpName", {
      get() {
        throw new Error("boom")
      },
    })

    await session.report()

    expect(logger.error.mock.calls).toEqual([
      ["[HireFire] Dispatch error: Error: boom"],
    ])
    expect(config().buffer.flush().web.rqt[1000]).toEqual({ sum: 7, count: 1 })
  })

  test("a halted session takes nothing from the buffer and posts nothing", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)

    session.halt()
    await session.report()

    expect(bodies).toEqual([])
    expect(config().buffer.flush().web.rqt[1000]).toEqual({ sum: 7, count: 1 })
  })

  test("the final flush of a halted session sends what is buffered", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)

    session.halt()
    await session.flush()

    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [7, 1] })
  })

  test("a dispatch that fails after a halt drops its samples", async () => {
    const session = configureWebOnly()
    nock(BASE)
      .post("/metrics/ingest")
      .reply(function () {
        session.halt()
        return [500]
      })
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)

    await session.report()

    expect(config().buffer.flush()).toEqual({})
    expect(session.failing).toBe(true)
  })

  test("a session is failing from a failed dispatch until the next one that succeeds", async () => {
    let status = 500
    nock(BASE)
      .persist()
      .post("/metrics/ingest")
      .reply(() => [status])
    const session = configureWebOnly()
    freezeTime(1000)
    expect(session.failing).toBe(false)

    await session.flush()
    expect(session.failing).toBe(true)

    status = 200
    await session.flush()
    expect(session.failing).toBe(false)
  })

  test("empty plan with local samplers still holds lease", async () => {
    stubLease(true, JSON.stringify({ version: 1, job_queues: [] }))
    config().dyno("worker", () => 5)
    const session = new Session(config())
    await jobQueuePass(session)
    expect(logger.info).not.toHaveBeenCalled()
    expect(nock.isDone()).toBe(true)
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.flush()
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

  test("a trace that makes the payload too large is left out, the metrics are sent, and the trace is not sent later", async () => {
    const queue = (letter) => letter.repeat(43000)
    stubLease(
      true,
      JSON.stringify({
        trace: true,
        job_queues: ["a", "b", "c"].map((letter) => ({
          name: "worker",
          strategy: "jqs",
          queues: [queue(letter)],
        })),
      }),
    )
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().dyno("worker", () => 3)
    const session = new Session(config())
    freezeTime(1000)
    for (let index = 0; index < 80; index++) {
      config().buffer.sample(`extra-${index}`, "jqs", 1)
    }
    await jobQueuePass(session)
    await session.flush()

    expect(bodies).toHaveLength(1)
    expect(bodies[0][0].sample_trace).toBeUndefined()
    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [] })
    expect(
      bodies[0].find((entry) => entry.name === "worker").metrics.jqs,
    ).toEqual({ 1000: 3 })
    expect(bodies[0]).toHaveLength(82)
    expect(logger.error).not.toHaveBeenCalled()

    freezeTime(1001)
    await session.flush()
    expect(bodies[1][0].metrics.rqt).toEqual({ 1001: [] })
    expect(bodies[1][0].sample_trace).toBeUndefined()
  })

  test("a payload of exactly 131072 bytes keeps its trace, and one byte more is sent without it", async () => {
    const limit = Session.PAYLOAD_SIZE_LIMIT
    stubLease(
      true,
      JSON.stringify({
        trace: true,
        job_queues: [{ name: "worker", strategy: "jqs" }],
      }),
    )
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 3)
    const session = new Session(config())
    const size = (body) => Buffer.byteLength(JSON.stringify(body))
    const traced = (body) => body.some((entry) => entry.sample_trace)

    async function send(second, name) {
      freezeTime(second)
      config().buffer.sample(name, "jqs", 1)
      await jobQueuePass(session)
      await session.flush()
      return bodies[bodies.length - 1]
    }

    const short = await send(1000, "n")
    expect(traced(short)).toBe(true)
    const name = "n".repeat(1 + limit - size(short))

    const exact = await send(1015, name)
    expect(size(exact)).toBe(limit)
    expect(traced(exact)).toBe(true)

    const over = await send(1030, `${name}n`)
    expect(traced(over)).toBe(false)
    expect(over.map((entry) => entry.name)).toContain(`${name}n`)
    expect(logger.error).not.toHaveBeenCalled()
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.flush()
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
    const session = new Session(config())
    await jobQueuePass(session)
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.flush()
    const entry = bodies[0].find((e) => e.name === "worker")
    expect(Object.values(entry.metrics.jqs)[0]).toBe(11)
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.flush()
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.flush()
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.flush()
    expect(bodies).toEqual([])
    expect(
      logger.error.mock.calls.some((c) =>
        String(c[0]).includes("Unknown plan adapter"),
      ),
    ).toBe(true)
  })

  test("a full plan of unknown adapters warns once per entry", async () => {
    expect(Once.LIMIT).toBe(Lease.MAX_JOB_QUEUES)
    stubLease(
      true,
      JSON.stringify({
        version: 1,
        job_queues: Array.from({ length: Lease.MAX_JOB_QUEUES }, (_, i) => ({
          name: `worker_${i}`,
          strategy: "jql",
          adapter: "nope",
          queues: [],
          options: {},
        })),
      }),
    )
    captureIngestBodies()
    config().dyno("other", () => 0)
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.sample()
    expect(
      logger.error.mock.calls.filter((call) =>
        String(call[0]).includes("Unknown plan adapter"),
      ),
    ).toHaveLength(Lease.MAX_JOB_QUEUES)
  })

  test("a second whose value is out of range is left out, and that is logged once per name and series", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    const limit = Payload.METRIC_VALUE_LIMIT
    freezeTime(999)
    config().buffer.sample("web", "rqt", 10)
    config().buffer.sample("worker", "jqs", limit)
    freezeTime(1000)
    config().buffer.sample("web", "rqt", limit * 2)
    config().buffer.sample("worker", "jqs", -1)
    await session.report()

    expect(bodies[0][0].metrics.rqt).toEqual({ 999: [10, 1] })
    expect(bodies[0][1].metrics.jqs).toEqual({ 999: limit })

    freezeTime(1001)
    config().buffer.sample("web", "rqt", -1)
    config().buffer.sample("worker", "jqs", limit + 1e3)
    config().buffer.sample("worker", "jql", -0.5)
    await session.report()

    expect(bodies[1].map((entry) => entry.name)).toEqual(["web"])
    expect(bodies[1][0].metrics.rqt).toBeUndefined()
    expect(logger.error.mock.calls).toEqual([
      ['[HireFire] Omitting rqt seconds of "web": a value is out of range.'],
      ['[HireFire] Omitting jqs seconds of "worker": a value is out of range.'],
      ['[HireFire] Omitting jql seconds of "worker": a value is out of range.'],
    ])
  })

  test("a payload the server calls too large is not sent again, and the next one starts after it", async () => {
    nock(BASE).post("/metrics/ingest").reply(413)
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const session = new Session(config())
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await session.flush()
    expect(config().buffer.flush()).toEqual({})

    freezeTime(1002)
    await session.flush()
    expect(bodies).toHaveLength(1)
    expect(bodies[0][0].metrics.rqt).toEqual({ 1001: [], 1002: [] })
  })

  test("a payload that is too large to send is dropped, and the next one starts after it", async () => {
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().markHttpActive()
    const session = new Session(config())
    freezeTime(1000)
    injectOversizedSeries()
    await session.flush()
    expect(bodies).toEqual([])
    expect(config().buffer.flush()).toEqual({})

    freezeTime(1002)
    await session.flush()
    expect(bodies[0][0].metrics.rqt).toEqual({ 1001: [], 1002: [] })
  })

  test("backfills seconds skipped between dispatches", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1003)
    await session.report()
    expect(bodies[1][0].metrics.rqt).toEqual({
      1001: [],
      1002: [],
      1003: [],
    })
  })

  test("backfill preserves buffered samples", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1003)
    config().buffer.sample("web", "rqt", 5)
    await session.report()
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
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1003)
    await session.report()
    freezeTime(1005)
    await session.report()
    const keys = Object.keys(bodies[2][0].metrics.rqt).sort()
    expect(keys).toEqual(["1001", "1002", "1003", "1004", "1005"])
  })

  test("backfill is capped at the limit", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1100)
    await session.report()
    const keys = Object.keys(bodies[1][0].metrics.rqt).map(Number)
    expect(Math.min(...keys)).toBe(1100 - Payload.RQT_BACKFILL_LIMIT)
    expect(Math.max(...keys)).toBe(1100)
    expect(keys.length).toBe(Payload.RQT_BACKFILL_LIMIT + 1)
  })

  test("lease unauthorized does not log error", async () => {
    nock(BASE).persist().post("/metrics/lease").reply(401)
    const bodies = captureIngestBodies()
    const session = configureWorkersOnly()
    await jobQueuePass(session)
    await session.report()
    expect(bodies).toEqual([])
    expect(loggerErrors()).not.toMatch(/\b401\b/)
  })

  test("a payload the server does not authorize is not sent again, and the next one starts after it", async () => {
    nock(BASE).post("/metrics/ingest").reply(401)
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 7)
    await session.report()
    expect(config().buffer.flush()).toEqual({})
    expect(logger.error).not.toHaveBeenCalled()

    freezeTime(1001)
    await session.report()
    expect(bodies).toHaveLength(1)
    expect(bodies[0][0].metrics.rqt).toEqual({ 1001: [] })
  })

  test("an oversized payload without web data drops without touching the watermark", async () => {
    const bodies = captureIngestBodies()
    const session = new Session(config())
    freezeTime(1000)
    injectOversizedSeries("worker", "jql")
    await session.report()
    expect(bodies).toEqual([])
    expect(loggerErrors()).toContain("Dropped metrics payload")
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
    const session = new Session(config())
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 5)
    await session.report()
    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
    expect(sampled).toBe(false)
  })

  test("job queue tick samples without dispatching and a later tick delivers it", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    config().dyno("worker", () => 42)
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    expect(bodies).toEqual([])
    await session.report()
    expect(bodies.length).toBe(1)
    expect(
      bodies[0].some((e) => e.name === "worker" && e.metrics && e.metrics.jql),
    ).toBe(true)
  })

  test("hyphen dyno samples and dispatches name as is", async () => {
    stubGrantedLease(
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker-latency",
            strategy: "jql",
            adapter: null,
            queues: [],
            options: {},
          },
        ],
      }),
    )
    const bodies = captureIngestBodies()
    process.env.DYNO = "worker-latency-6d7f788ddb-cdct6"
    config().dyno("worker-latency", () => 7)
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.report()
    const names = bodies[0].map((e) => e.name)
    expect(names).toContain("worker-latency")
    expect(names).not.toContain("worker")
    const entry = bodies[0].find((e) => e.name === "worker-latency")
    expect(entry.metrics.jql["1000"]).toBe(7)
    expect(loggerErrors()).not.toMatch(/local sampler is ignored/)
  })

  test("combined web and worker dispatch", async () => {
    stubGrantedLease()
    const bodies = captureIngestBodies()
    freezeTime(1000)
    const session = configureWebAndWorkers()
    config().buffer.sample("web", "rqt", 5)
    await jobQueuePass(session)
    await session.report()
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
    const session = configureWorkersOnly()
    freezeTime(1000)
    await jobQueuePass(session)
    await session.report()
    expect(
      bodies[0].some((e) => e.name === "worker" && e.metrics && e.metrics.jql),
    ).toBe(true)
  })

  test("lease denied skips worker collection", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    const session = configureWorkersOnly()
    await jobQueuePass(session)
    await session.report()
    expect(bodies).toEqual([])
  })

  test("cpu first tick seeds baseline without dispatching", async () => {
    const bodies = captureIngestBodies()
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValue({ seconds: 0.0, source: "cgroupV2" })
    const session = configureCpuOnly("clock")
    freezeTime(1000)
    await session.report()
    expect(bodies).toEqual([])
  })

  test("cpu samples are not repopulated on dispatch failure", async () => {
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1)
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce({ seconds: 0.0, source: "cgroupV2" })
      .mockReturnValue({ seconds: 0.5, source: "cgroupV2" })
    const session = configureCpuOnly("clock")
    freezeTime(1000)
    await session.report()
    freezeTime(1001)
    await session.report()
    const data = config().buffer.flush()
    expect(data.clock && data.clock.cpu).toBeUndefined()
  })

  test("non web process does not heartbeat the web name", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "worker.1"
    config().dyno("web")
    const session = new Session(config())
    freezeTime(1000)
    await session.report()
    expect(bodies).toEqual([])
  })

  test("non web process still delivers real web samples", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "worker.1"
    config().dyno("web")
    const session = new Session(config())
    freezeTime(1000)
    config().buffer.sample("web", "rqt", 12)
    await session.report()
    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [12, 1] })
  })

  test("matching identity keeps heartbeat and backfill", async () => {
    stubLease()
    const bodies = captureIngestBodies()
    process.env.DYNO = "web.1"
    config().dyno("web")
    const session = new Session(config())
    freezeTime(1000)
    await session.report()
    freezeTime(1002)
    await session.report()
    expect(bodies[0][0].metrics.rqt).toEqual({ 1000: [] })
    expect(bodies[1][0].metrics.rqt).toEqual({ 1001: [], 1002: [] })
  })

  test("tick dispatches when the lease request fails", async () => {
    nock(BASE).persist().post("/metrics/lease").replyWithError({
      code: "ECONNREFUSED",
    })
    const bodies = captureIngestBodies()
    freezeTime(1000)
    const session = configureWebAndWorkers()
    config().buffer.sample("web", "rqt", 12)
    await jobQueuePass(session)
    await session.report()
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.report()
    expect(bodies.length).toBe(1)
    expect(bodies[0].map((e) => e.name)).toEqual(["web"])
    expect(loggerErrors()).toContain("Redis down")
  })

  test("web only dispatch never requests a lease", async () => {
    const lease = nock(BASE).post("/metrics/lease").reply(200)
    captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    expect(lease.isDone()).toBe(false)
  })

  test("dispatch frequency defaults to one without the header", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1001)
    await session.report()
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
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1002)
    await session.report()
    freezeTime(1004)
    await session.report()
    freezeTime(1004.9)
    await session.report()
    expect(posts).toBe(1)
    freezeTime(1005)
    await session.report()
    expect(posts).toBe(2)
  })

  test("clamps an over large dispatch frequency to the maximum", async () => {
    expect(Session.MAX_DISPATCH_FREQUENCY).toBe(30)
    const bodies = captureIngestBodiesWithDispatchFrequency(130)
    const session = configureWebOnly()
    freezeTime(1000)
    await session.report()
    freezeTime(1029.9)
    await session.report()
    expect(bodies).toHaveLength(1)
    freezeTime(1030)
    await session.report()
    expect(bodies).toHaveLength(2)
  })

  test.each([0, -5, "nonsense", "5s", "1.5", ""])(
    "keeps its dispatch frequency when the server sends %j",
    async (value) => {
      expect(Session.DEFAULT_DISPATCH_FREQUENCY).toBe(1)
      const bodies = captureIngestBodiesWithDispatchFrequency(value)
      const session = configureWebOnly()
      freezeTime(1000)
      await session.report()
      freezeTime(1000.9)
      await session.report()
      expect(bodies).toHaveLength(1)
      freezeTime(1001)
      await session.report()
      expect(bodies).toHaveLength(2)
    },
  )

  test("dispatch failure without web data does not repopulate", async () => {
    stubGrantedLease()
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    const session = configureWorkersOnly()
    freezeTime(1000)
    await jobQueuePass(session)
    await session.report()
    expect(config().buffer.flush().web).toBeUndefined()
    expect(loggerErrors()).toContain("Dispatch error")
  })

  test("dispatch pacing follows the monotonic clock not the wall clock", async () => {
    const bodies = captureIngestBodies()
    const session = configureWebOnly()
    jest.spyOn(Date, "now").mockReturnValue(1000 * 1000)
    let mono = 500000
    jest.spyOn(performance, "now").mockImplementation(() => mono)
    await session.report()
    mono = 502000
    await session.report()
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
    const session = new Session(config())
    freezeTime(1000)
    await session.report()
    freezeTime(1001)
    config().buffer.sample("web", "rqt", 12)
    await session.report()
    const entry = bodies[bodies.length - 1].find((e) => e.name === "web")
    expect(entry.metrics.rqt).toBeDefined()
    expect(entry.metrics.cpu).toBeDefined()
  })

  test("jql not repopulated on dispatch failure", async () => {
    stubGrantedLease()
    nock(BASE).persist().post("/metrics/ingest").reply(500)
    freezeTime(1000)
    config().dyno("worker", () => 3)
    const session = new Session(config())
    await jobQueuePass(session)
    await session.report()
    expect(Object.keys(config().buffer.flush())).toHaveLength(0)
    expect(loggerErrors()).toContain("Dispatch error")
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
    const session = new Session(config())
    freezeTime(1000)
    await jobQueuePass(session)
    await session.report()
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
    const session = new Session(config())
    config().buffer.sample("web", "rqt", 12)
    config().buffer.sample("web", "cpu", 25.0)
    await jobQueuePass(session)
    await session.report()
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

  describe("with the lease and a plan that asks for a trace", () => {
    let bodies
    let leases
    let grant

    beforeEach(() => {
      process.env.DYNO = "web.1"
      leases = []
      grant = {
        trace: true,
        job_queues: [
          { name: "worker", strategy: "jqs" },
          { name: "mailer", strategy: "jqs" },
        ],
      }
      nock(BASE)
        .persist()
        .post("/metrics/lease")
        .reply(function () {
          leases.push(this.req.headers["hirefire-process-id"])
          return [
            200,
            JSON.stringify(grant),
            {
              "HireFire-Lease-Granted": "true",
              "HireFire-Sample-Frequency": "15",
              "HireFire-Lease-TTL": "15",
            },
          ]
        })
    })

    function traces() {
      return bodies.map((body) => body[0].sample_trace?.ops.length ?? null)
    }

    test("the trace of a round that ends during a dispatch is sent with the next payload", async () => {
      config().dyno("worker", () => 1)
      const session = new Session(config())
      bodies = []
      nock(BASE)
        .persist()
        .post("/metrics/ingest")
        .reply(function (uri, body, callback) {
          bodies.push(body)
          if (bodies.length > 1) return callback(null, [200])
          freezeTime(1015)
          grant.job_queues = [{ name: "worker", strategy: "jqs" }]
          jobQueuePass(session).then(() => callback(null, [200]))
        })

      freezeTime(1000)
      await jobQueuePass(session)
      await session.flush()
      freezeTime(1016)
      await session.flush()
      freezeTime(1017)
      await session.flush()

      expect(traces()).toEqual([2, 1, null])
    })

    test("a trace sent with a payload the server calls too large is not sent again", async () => {
      config().dyno("worker", () => 1)
      const session = new Session(config())
      nock(BASE).post("/metrics/ingest").reply(413)
      bodies = captureIngestBodies()

      freezeTime(1000)
      await jobQueuePass(session)
      await session.flush()
      freezeTime(1001)
      await session.flush()

      expect(traces()).toEqual([null])
    })

    test("a session halted during a round samples no further entry and traces only what ran", async () => {
      const mailer = jest.fn(() => 2)
      const session = new Session(config())
      config().dyno("worker", () => {
        session.halt()
        return 1
      })
      config().dyno("mailer", mailer)
      bodies = captureIngestBodies()

      freezeTime(1000)
      await jobQueuePass(session)
      await session.flush()

      expect(mailer).not.toHaveBeenCalled()
      expect(traces()).toEqual([1])
      expect(bodies[0].map((entry) => entry.name)).toEqual(["web"])
    })

    describe("and a sampler that does not return", () => {
      let release
      let session
      let round

      beforeEach(async () => {
        config().dyno(
          "worker",
          () => new Promise((resolve) => (release = resolve)),
        )
        grant.job_queues = [{ name: "worker", strategy: "jqs" }]
        session = new Session(config())
        freezeTime(1000)
        await session.renew()
        round = session.sample()
      })

      function warnings() {
        return logger.warn.mock.calls.map(([message]) => message)
      }

      test("the lease is renewed while the round is still running", async () => {
        freezeTime(1015)
        await session.renew()
        freezeTime(1030)
        await session.renew()

        expect(leases).toHaveLength(3)
        expect(new Set(leases).size).toBe(1)
        expect(warnings()).toEqual([])
        release(4)
        await round
      })

      test("a round inside its limit keeps the lease and its sample", async () => {
        expect(Session.SAMPLE_ROUND_LIMIT).toBe(60)
        bodies = captureIngestBodies()
        freezeTime(1060)
        await session.renew()
        release(4)
        await round
        await session.flush()

        expect(leases).toHaveLength(2)
        expect(warnings()).toEqual([])
        expect(
          bodies[0].find((entry) => entry.name === "worker").metrics,
        ).toEqual({ jqs: { 1060: 4 } })
      })

      test("a round that runs past its limit gives up the lease and its samples, and no lease is asked for until it returns", async () => {
        bodies = captureIngestBodies()
        freezeTime(1060.001)
        await session.renew()
        freezeTime(1075)
        await session.renew()
        await session.renew()

        expect(leases).toHaveLength(1)
        expect(warnings()).toEqual([
          "[HireFire] A job queue sample round has run for more than 60 seconds. " +
            "The lease is released so that another process can sample.",
        ])

        release(4)
        await round
        await session.flush()
        expect(bodies[0].map((entry) => entry.name)).toEqual(["web"])
        expect(bodies[0][0].sample_trace).toBeUndefined()

        await session.renew()
        expect(leases).toHaveLength(2)
        expect(warnings()).toHaveLength(1)
      })
    })
  })
})
