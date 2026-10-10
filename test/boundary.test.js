const https = require("https")
const nock = require("nock")
const HireFire = require("../src")

const BASE = "https://data.hirefire.io"
const START = 1_767_225_600

describe("the client at its boundary", () => {
  let log
  let requests
  let answers
  let inFlight

  beforeEach(() => {
    jest.useFakeTimers({
      now: START * 1000,
      doNotFake: ["nextTick", "setImmediate", "clearImmediate"],
    })
    process.env.HIREFIRE_TOKEN = "boundary-token"
    log = []
    requests = []
    inFlight = 0
    answers = { ingest: () => [200], lease: () => [200, "", denied()] }
    const send = https.request
    jest.spyOn(https, "request").mockImplementation((options, callback) => {
      let open = true
      const done = () => {
        if (open) inFlight -= 1
        open = false
      }
      inFlight += 1
      const request = send.call(https, options, (response) => {
        response.once("end", done)
        response.once("error", done)
        callback(response)
      })
      request.once("error", done)
      return request
    })
    for (const path of ["ingest", "lease"]) {
      nock(BASE)
        .persist()
        .post(`/metrics/${path}`)
        .reply(function (_uri, body, callback) {
          const request = {
            path,
            at: Math.floor(Date.now() / 1000) - START,
            headers: this.req.headers,
            body,
          }
          requests.push(request)
          const answer = answers[path](request)
          if (answer instanceof Error) callback(answer)
          else callback(null, answer)
        })
    }
  })

  afterEach(async () => {
    await HireFire.configuration.dispatcher.stop({ flush: false })
    jest.useRealTimers()
  })

  function configure(fn = () => {}) {
    HireFire.configure((config) => {
      config.logger = {
        info: (message) => log.push(`I ${message}`),
        warn: (message) => log.push(`W ${message}`),
        error: (message) => log.push(`E ${message}`),
      }
      fn(config)
    })
  }

  async function settle() {
    for (let turn = 0, quiet = 0; quiet < 5 && turn < 5000; turn += 1) {
      await new Promise((resolve) => setImmediate(resolve))
      quiet = inFlight === 0 ? quiet + 1 : 0
    }
  }

  async function pass(seconds) {
    await settle()
    for (let second = 0; second < seconds; second += 1) {
      await jest.advanceTimersByTimeAsync(1000)
      await settle()
    }
  }

  function denied(headers = {}) {
    return { "HireFire-Lease-Granted": "false", ...headers }
  }

  function granted(plan, headers = {}) {
    return [
      200,
      JSON.stringify({ job_queues: plan }),
      { "HireFire-Lease-Granted": "true", ...headers },
    ]
  }

  function at(path) {
    return requests
      .filter((request) => request.path === path)
      .map((request) => request.at)
  }

  function ingested(name, strategy) {
    const series = {}
    for (const request of requests) {
      if (request.path !== "ingest") continue
      for (const entry of request.body) {
        if (entry.name !== name || !entry.metrics[strategy]) continue
        for (const [second, leaf] of Object.entries(entry.metrics[strategy])) {
          series[Number(second) - START] = leaf
        }
      }
    }
    return series
  }

  function logged(level) {
    return log.filter((line) => line.startsWith(`${level} `))
  }

  describe("a web process", () => {
    beforeEach(() => {
      process.env.DYNO = "web.1"
    })

    test("reports every second of request queue time once, also a second without a request", async () => {
      configure()
      HireFire.configuration.buffer.sample("web", "rqt", 30)
      HireFire.configuration.buffer.sample("web", "rqt", 50)
      await pass(3)

      expect(at("ingest")).toEqual([0, 1, 2, 3])
      expect(ingested("web", "rqt")).toEqual({
        0: [40, 2],
        1: [],
        2: [],
        3: [],
      })
      expect(at("lease")).toEqual([])
    })

    test("sends the token, the agent, and JSON on every ingest request", async () => {
      configure()
      await pass(0)

      expect(requests[0].headers).toMatchObject({
        "content-type": "application/json",
        "hirefire-token": "boundary-token",
        "hirefire-agent": `Node-${require("../package.json").version}`,
      })
    })

    test("dispatches as often as the server asks", async () => {
      answers.ingest = () => [200, "", { "HireFire-Dispatch-Frequency": "5" }]
      configure()
      await pass(12)

      expect(at("ingest")).toEqual([0, 5, 10])
      expect(Object.keys(ingested("web", "rqt")).map(Number)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
      ])
    })

    test("sends the seconds of a failed dispatch again with the next one", async () => {
      let fail = true
      answers.ingest = () => (fail ? [500] : [200])
      configure()
      HireFire.configuration.buffer.sample("web", "rqt", 80)
      await pass(0)
      fail = false
      await pass(1)

      expect(requests[1].body[0].metrics.rqt).toEqual({
        [START]: [80, 1],
        [START + 1]: [],
      })
      expect(logged("E")).toEqual([
        "E [HireFire] Dispatch error: RequestError: Ingest request failed with 500 status.",
      ])
    })

    test("a stop sends what is buffered and nothing after it", async () => {
      configure()
      await pass(1)
      HireFire.configuration.buffer.sample("web", "rqt", 12)
      expect(await HireFire.configuration.dispatcher.stop()).toBe(true)
      const sent = requests.length
      await pass(5)

      expect(ingested("web", "rqt")[1]).toEqual([12, 1])
      expect(requests).toHaveLength(sent)
      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatcher stopped.",
      ])
    })

    test("a stop without a flush sends nothing more", async () => {
      configure()
      await pass(1)
      HireFire.configuration.buffer.sample("web", "rqt", 12)
      await HireFire.configuration.dispatcher.stop({ flush: false })
      await pass(2)

      expect(at("ingest")).toEqual([0, 1])
      expect(HireFire.configuration.buffer.flush()).toEqual({})
    })

    test("an ingest the server does not authorize is not logged and not sent again", async () => {
      answers.ingest = () => [401]
      configure()
      HireFire.configuration.buffer.sample("web", "rqt", 80)
      await pass(2)

      expect(at("ingest")).toEqual([0, 1, 2])
      expect(requests[1].body[0].metrics.rqt).toEqual({ [START + 1]: [] })
      expect(logged("E")).toEqual([])
    })

    test("a payload the server calls too large is dropped with one log line", async () => {
      let reject = true
      answers.ingest = () => (reject ? [413] : [200])
      configure()
      HireFire.configuration.buffer.sample("web", "rqt", 80)
      await pass(0)
      reject = false
      await pass(1)

      expect(requests[1].body[0].metrics.rqt).toEqual({ [START + 1]: [] })
      expect(logged("E")).toEqual([
        `E [HireFire] Dropped metrics payload: ${
          JSON.stringify(requests[0].body).length
        } bytes server rejected (413). Resuming from the current second.`,
      ])
    })

    test("a dispatch that cannot reach the server is logged and tried again a second later", async () => {
      let down = true
      answers.ingest = () =>
        down
          ? Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
          : [200]
      configure()
      HireFire.configuration.buffer.sample("web", "rqt", 80)
      await pass(1)
      down = false
      await pass(1)

      expect(at("ingest")).toEqual([0, 1, 2])
      expect(requests[2].body[0].metrics.rqt).toEqual({
        [START]: [80, 1],
        [START + 2]: [],
      })
      expect(logged("E")).toHaveLength(2)
      expect(logged("E")[0]).toBe(
        "E [HireFire] Dispatch error: RequestError: Network error (ECONNREFUSED: refused).",
      )
    })

    test("keeps at most the last 60 seconds for a server that was away", async () => {
      let down = false
      answers.ingest = () => (down ? [503] : [200])
      configure()
      await pass(0)
      down = true
      await pass(90)
      down = false
      await pass(1)

      const seconds = Object.keys(
        requests[requests.length - 1].body[0].metrics.rqt,
      )
      expect(seconds).toHaveLength(61)
      expect(Number(seconds[0])).toBe(START + 31)
      expect(Number(seconds[60])).toBe(START + 91)
    })

    test("does not dispatch more often than once a second or less often than every 30", async () => {
      answers.ingest = () => [200, "", { "HireFire-Dispatch-Frequency": "0" }]
      configure()
      await pass(2)
      expect(at("ingest")).toEqual([0, 1, 2])

      answers.ingest = () => [200, "", { "HireFire-Dispatch-Frequency": "900" }]
      await pass(61)
      expect(at("ingest")).toEqual([0, 1, 2, 3, 33, 63])
    })

    test("logs each payload when HIREFIRE_VERBOSE is set", async () => {
      process.env.HIREFIRE_VERBOSE = "1"
      configure()
      await pass(0)

      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        `I [HireFire] Dispatching metrics: ${JSON.stringify(requests[0].body)}`,
      ])
    })

    test("reports CPU under the name of the process", async () => {
      configure()
      await pass(2)

      const seconds = Object.keys(ingested("web", "cpu")).map(Number)
      expect(seconds).toEqual([1, 2])
      for (const value of Object.values(ingested("web", "cpu"))) {
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(100)
      }
    })
  })

  describe("a process that serves requests", () => {
    const { processRequestQueueTime } = require("../src/middleware")

    test("starts with its first request and reports the time that request waited", async () => {
      process.env.HIREFIRE_SERVICE_NAME = "app"
      HireFire.configuration.logger = { info() {}, warn() {}, error() {} }
      processRequestQueueTime(() => `t=${START - 0.25}`)
      await pass(1)

      expect(at("ingest")).toEqual([0, 1])
      expect(ingested("app", "rqt")).toEqual({ 0: [250, 1], 1: [] })
    })

    test("reports nothing for a request without a start header", async () => {
      process.env.HIREFIRE_SERVICE_NAME = "app"
      processRequestQueueTime(() => undefined)
      await pass(2)

      expect(requests).toEqual([])
    })
  })

  describe("a process whose name cannot be resolved", () => {
    test("says so once and reports nothing", async () => {
      configure()
      await pass(3)

      expect(requests).toEqual([])
      expect(log.sort()).toEqual([
        "I [HireFire] Starting dispatcher.",
        "W [HireFire] CPU metrics disabled: process identity is unresolved. Set HIREFIRE_SERVICE_NAME or DYNO.",
      ])
    })
  })

  describe("a process without a token", () => {
    test("sends nothing and logs nothing", async () => {
      delete process.env.HIREFIRE_TOKEN
      process.env.DYNO = "web.1"
      configure((config) => config.dyno("worker", () => 1))
      await pass(3)

      expect(requests).toEqual([])
      expect(log).toEqual([])
    })
  })

  describe("a process with a sampler", () => {
    beforeEach(() => {
      process.env.DYNO = "worker.1"
    })

    test("asks for the lease at once and again when it runs out", async () => {
      configure((config) => config.dyno("worker", () => 7))
      await pass(31)

      expect(at("lease")).toEqual([0, 15, 30])
      expect(ingested("worker", "jqs")).toEqual({})
    })

    test("renews as often as the server asks", async () => {
      answers.lease = () => [200, "", denied({ "HireFire-Lease-TTL": "5" })]
      configure((config) => config.dyno("worker", () => 7))
      await pass(11)

      expect(at("lease")).toEqual([0, 5, 10])
    })

    test("keeps one identity for its lease requests", async () => {
      configure((config) => config.dyno("worker", () => 7))
      await pass(15)

      const ids = requests
        .filter((request) => request.path === "lease")
        .map((request) => request.headers["hirefire-process-id"])
      expect(ids).toHaveLength(2)
      expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/)
      expect(ids[1]).toBe(ids[0])
    })

    test("samples what the plan names when it holds the lease, as often as the server asks", async () => {
      let size = 7
      answers.lease = () =>
        granted([{ name: "worker", strategy: "jqs" }], {
          "HireFire-Sample-Frequency": "4",
          "HireFire-Lease-TTL": "5",
        })
      configure((config) => config.dyno("worker", () => size++))
      await pass(9)

      expect(ingested("worker", "jqs")).toEqual({ 0: 7, 4: 8, 8: 9 })
      expect(at("lease")).toEqual([0, 5])
    })

    test("samples nothing without the lease", async () => {
      const sampler = jest.fn(() => 7)
      configure((config) => config.dyno("worker", sampler))
      await pass(20)

      expect(sampler).not.toHaveBeenCalled()
    })

    test("stops sampling when the lease goes to another process", async () => {
      let holds = true
      const sampler = jest.fn(() => 7)
      answers.lease = () =>
        holds
          ? granted([{ name: "worker", strategy: "jqs" }], {
              "HireFire-Sample-Frequency": "1",
              "HireFire-Lease-TTL": "5",
            })
          : [200, "", denied({ "HireFire-Lease-TTL": "5" })]
      configure((config) => config.dyno("worker", sampler))
      await pass(4)
      holds = false
      await pass(6)

      expect(Object.keys(ingested("worker", "jqs")).map(Number)).toEqual([
        0, 1, 2, 3, 4,
      ])
      expect(sampler).toHaveBeenCalledTimes(5)
    })

    test("a sampler that raises costs its sample and one log line, and the next round samples again", async () => {
      let fail = true
      answers.lease = () =>
        granted([{ name: "worker", strategy: "jqs" }], {
          "HireFire-Sample-Frequency": "1",
        })
      configure((config) =>
        config.dyno("worker", () => {
          if (fail) throw new Error("redis://user:secret@host is down")
          return 3
        }),
      )
      await pass(0)
      fail = false
      await pass(2)
      await HireFire.configuration.dispatcher.stop()

      expect(ingested("worker", "jqs")).toEqual({ 1: 3, 2: 3 })
      expect(logged("E")).toEqual(
        [
          '[HireFire] The sampler for "worker" raised Error: redis://***@host is down',
        ].map((line) => `E ${line}`),
      )
    })

    test("reports latency when the plan asks for it", async () => {
      answers.lease = () => granted([{ name: "worker", strategy: "jql" }])
      configure((config) => config.dyno("worker", () => 2.5))
      await pass(1)

      expect(ingested("worker", "jql")).toEqual({ 0: 2.5 })
      expect(ingested("worker", "jqs")).toEqual({})
    })

    test("drops a sample that is not a number of zero or more and says why", async () => {
      answers.lease = () =>
        granted([
          { name: "worker", strategy: "jqs" },
          { name: "mailer", strategy: "jqs" },
        ])
      configure((config) => {
        config.dyno("worker", () => "12")
        config.dyno("mailer", () => -1)
      })
      await pass(1)

      expect(ingested("worker", "jqs")).toEqual({})
      expect(ingested("mailer", "jqs")).toEqual({})
      expect(logged("E")).toEqual([
        'E [HireFire] The sampler for "worker" returned string("12"), expected a non-negative number. Sample dropped.',
        'E [HireFire] The sampler for "mailer" returned number("-1"), expected a non-negative number. Sample dropped.',
      ])
    })

    test("skips a plan entry it cannot sample and says so once", async () => {
      answers.lease = () =>
        granted(
          [
            { name: "worker", strategy: "jqs" },
            { name: "worker", strategy: "nope" },
            { name: "mailer", strategy: "jqs", adapter: "sidekiq" },
            { name: "other", strategy: "jqs" },
          ],
          { "HireFire-Sample-Frequency": "1" },
        )
      configure((config) => config.dyno("worker", () => 4))
      await pass(3)
      await HireFire.configuration.dispatcher.stop()

      expect(Object.keys(ingested("worker", "jqs"))).toEqual([
        "0",
        "1",
        "2",
        "3",
      ])
      expect(logged("E")).toEqual([
        'E [HireFire] Unknown plan strategy "nope" for "worker". Entry skipped.',
        'E [HireFire] Unknown plan adapter "sidekiq" for "mailer". Entry skipped.',
      ])
    })

    test("sends the trace of a sample round once when the server asks for it", async () => {
      answers.lease = () => [
        200,
        JSON.stringify({
          trace: true,
          job_queues: [{ name: "worker", strategy: "jqs", queues: ["a"] }],
        }),
        { "HireFire-Lease-Granted": "true" },
      ]
      configure((config) => config.dyno("worker", () => 4))
      await pass(3)

      const traces = requests
        .filter((request) => request.path === "ingest")
        .map((request) => request.body[0].sample_trace)
        .filter(Boolean)
      expect(traces).toHaveLength(1)
      expect(traces[0]).toEqual({
        wave_ms: expect.any(Number),
        ops: [
          {
            adapter: null,
            strategy: "jqs",
            queues: ["a"],
            options: {},
            ms: expect.any(Number),
          },
        ],
      })
    })

    test("a lease request the server does not authorize is not logged", async () => {
      answers.lease = () => [401]
      const sampler = jest.fn(() => 7)
      configure((config) => config.dyno("worker", sampler))
      await pass(16)

      expect(at("lease")).toEqual([0, 15])
      expect(sampler).not.toHaveBeenCalled()
      expect(logged("E")).toEqual([])
    })

    test("a lease request that fails is logged and asked again when the lease would run out", async () => {
      answers.lease = () => [500]
      configure((config) => config.dyno("worker", () => 7))
      await pass(16)

      expect(at("lease")).toEqual([0, 15])
      expect(logged("E")).toEqual([
        "E [HireFire] RequestError: Lease request failed with 500 status.",
        "E [HireFire] RequestError: Lease request failed with 500 status.",
      ])
    })

    test("a lease request that fails takes the lease away", async () => {
      let fail = false
      const sampler = jest.fn(() => 7)
      answers.lease = () =>
        fail
          ? [500]
          : granted([{ name: "worker", strategy: "jqs" }], {
              "HireFire-Sample-Frequency": "1",
              "HireFire-Lease-TTL": "5",
            })
      configure((config) => config.dyno("worker", sampler))
      await pass(4)
      fail = true
      await pass(5)

      expect(sampler).toHaveBeenCalledTimes(5)
    })

    test("ignores a plan it cannot read and says why", async () => {
      answers.lease = () => [
        200,
        "{not json",
        { "HireFire-Lease-Granted": "true" },
      ]
      const sampler = jest.fn(() => 7)
      configure((config) => config.dyno("worker", sampler))
      await pass(1)

      expect(sampler).not.toHaveBeenCalled()
      expect(logged("E")).toEqual([
        "E [HireFire] Lease grant body was not valid JSON. Plan ignored.",
      ])
    })

    test("a start after a stop asks for the lease again", async () => {
      configure((config) => config.dyno("worker", () => 7))
      await pass(2)
      await HireFire.configuration.dispatcher.stop()
      HireFire.boot()
      await pass(1)

      expect(at("lease")).toEqual([0, 2])
    })
  })

  describe("a process that the plan names by adapter", () => {
    test("stays out of the race for the lease when no queue library is installed and no sampler is set", async () => {
      process.env.DYNO = "worker.1"
      const Plan = require("../src/plan")
      jest
        .spyOn(Plan, "anyAllowlistedJobQueueLibraryLoaded")
        .mockReturnValue(false)
      configure()
      await pass(20)

      expect(at("lease")).toEqual([])
      expect(at("ingest").length).toBeGreaterThan(0)
    })
  })
})
