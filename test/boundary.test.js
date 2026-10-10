const cluster = require("cluster")
const https = require("https")
const nock = require("nock")
const HireFire = require("../src")
const Plan = require("../src/plan")
const { planAdapter } = require("./support")

const BASE = "https://data.hirefire.io"
const START = 1_767_225_600

describe("the client at its boundary", () => {
  let log
  let requests
  let answers
  let inFlight
  let held

  beforeEach(() => {
    jest.useFakeTimers({
      now: START * 1000,
      doNotFake: ["nextTick", "setImmediate", "clearImmediate"],
    })
    process.env.HIREFIRE_TOKEN = "boundary-token"
    log = []
    requests = []
    inFlight = 0
    held = 0
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
          Promise.resolve(answers[path](request)).then((answer) => {
            if (answer instanceof Error) callback(answer)
            else callback(null, answer)
          })
        })
    }
  })

  afterEach(async () => {
    const stop = HireFire.configuration.dispatcher.stop({ flush: false })
    await jest.advanceTimersByTimeAsync(10_000)
    await stop
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
      quiet = inFlight <= held ? quiet + 1 : 0
    }
  }

  async function pass(seconds) {
    await settle()
    for (let second = 0; second < seconds; second += 1) {
      await jest.advanceTimersByTimeAsync(1000)
      await settle()
    }
  }

  function after(seconds, answer) {
    held += 1
    return new Promise((resolve) =>
      setTimeout(() => {
        held -= 1
        resolve(answer)
      }, seconds * 1000),
    )
  }

  function dispatcher() {
    return HireFire.configuration.dispatcher
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

    test("sends the token, the agent, a user agent, and JSON on every ingest request", async () => {
      const { version } = require("../package.json")
      configure()
      await pass(0)

      expect(requests[0].headers).toMatchObject({
        "content-type": "application/json",
        "hirefire-token": "boundary-token",
        "hirefire-agent": `Node-${version}`,
        "user-agent": `hirefire-resource-node/${version}`,
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
      let fail = false
      answers.ingest = () => (fail ? [500] : [200])
      configure()
      await pass(0)
      fail = true
      HireFire.configuration.buffer.sample("web", "rqt", 80)
      await pass(1)
      fail = false
      await pass(2)

      expect(at("ingest")).toEqual([0, 1, 3])
      expect(requests[2].body[0].metrics.rqt).toEqual({
        [START]: [80, 1],
        [START + 1]: [],
        [START + 2]: [],
        [START + 3]: [],
      })
      expect(logged("E")).toEqual([
        "E [HireFire] Dispatch error: RequestError: Ingest request failed with 500 status.",
      ])
      expect(logged("I")).toEqual(["I [HireFire] Starting dispatcher."])
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

    test("a token the server does not know is tried as seldom as the server asks", async () => {
      answers.ingest = () => [401, "", { "HireFire-Dispatch-Frequency": "30" }]
      configure()
      await pass(61)

      expect(at("ingest")).toEqual([0, 30, 60])
    })

    test("a server that calls a payload too large is asked as seldom as it asks", async () => {
      answers.ingest = () => [413, "", { "HireFire-Dispatch-Frequency": "5" }]
      configure()
      await pass(11)

      expect(at("ingest")).toEqual([0, 5, 10])
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

    test("a dispatch that fails waits twice as long before each next try, up to 30 seconds, and logs one line a minute", async () => {
      let down = true
      answers.ingest = () =>
        down
          ? Object.assign(new Error("refused"), { code: "ECONNREFUSED" })
          : [200]
      configure()
      await pass(60)

      expect(at("ingest")).toEqual([0, 2, 6, 14, 30, 60])
      expect(logged("E")).toEqual([
        "E [HireFire] Dispatch error: RequestError: Network error (ECONNREFUSED: refused).",
        "E [HireFire] Dispatch error: RequestError: Network error (ECONNREFUSED: refused). (6 failed attempts in a row)",
      ])

      down = false
      await pass(32)

      expect(at("ingest")).toEqual([0, 2, 6, 14, 30, 60, 90, 91, 92])
      expect(logged("E")).toHaveLength(2)
      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatch recovered after 6 failed attempts.",
      ])
    })

    test("a dispatch that fails once is tried again two seconds later and its recovery is not logged", async () => {
      let down = true
      answers.ingest = () => (down ? [503] : [200])
      configure()
      await pass(0)
      down = false
      await pass(4)

      expect(at("ingest")).toEqual([0, 2, 3, 4])
      expect(logged("I")).toEqual(["I [HireFire] Starting dispatcher."])
    })

    test("a server that keeps calling the payload too large is logged once a minute with a count", async () => {
      answers.ingest = () => [413]
      configure()
      await pass(60)

      expect(at("ingest")).toHaveLength(61)
      expect(logged("E")).toEqual([
        `E [HireFire] Dropped metrics payload: ${
          JSON.stringify(requests[0].body).length
        } bytes server rejected (413). Resuming from the current second.`,
        `E [HireFire] Dropped metrics payload: ${
          JSON.stringify(requests[60].body).length
        } bytes server rejected (413). Resuming from the current second. (61 failed attempts in a row)`,
      ])
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

  describe("a process with a data URL of its own", () => {
    beforeEach(() => {
      process.env.DYNO = "worker.1"
    })

    test("warns once when the URL sends the token in clear text", async () => {
      process.env.HIREFIRE_DATA_URL = "http://metrics.example"
      configure((config) => config.dyno("worker", () => 1))
      await pass(3)

      expect(logged("W")).toEqual([
        "W [HireFire] HIREFIRE_DATA_URL uses http, so the HireFire token is sent to metrics.example in clear text. Use an https URL.",
      ])
    })

    test("names the variable when the URL cannot be used", async () => {
      process.env.HIREFIRE_DATA_URL = "data.example.com"
      configure((config) => config.dyno("worker", () => 1))
      await pass(1)

      expect(logged("E").sort()).toEqual([
        "E [HireFire] Dispatch error: RequestError: HIREFIRE_DATA_URL must be an http or https URL with a host.",
        "E [HireFire] Lease request error: RequestError: HIREFIRE_DATA_URL must be an http or https URL with a host.",
      ])
      expect(requests).toEqual([])
    })
  })

  describe("a Heroku one-off dyno", () => {
    test.each(["run.4821", "release.1234"])(
      "named %s sends nothing and logs nothing",
      async (dyno) => {
        process.env.DYNO = dyno
        configure((config) => config.dyno("worker", () => 1))
        HireFire.boot()
        await pass(3)

        expect(requests).toEqual([])
        expect(log).toEqual([])
      },
    )

    test("sends nothing for a request it serves", async () => {
      process.env.DYNO = "run.4821"
      require("../src/middleware").processRequestQueueTime(
        () => `t=${START - 0.25}`,
      )
      await pass(3)

      expect(requests).toEqual([])
      expect(HireFire.configuration.buffer.flush()).toEqual({})
    })

    test("is told by DYNO alone, so a service name does not start it", async () => {
      process.env.DYNO = "run.4821"
      process.env.HIREFIRE_SERVICE_NAME = "web"
      configure()
      await pass(3)

      expect(requests).toEqual([])
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

    test("keeps its pace when the server sends a pace that is not a positive whole number", async () => {
      const sampler = jest.fn(() => 1)
      answers.lease = () =>
        granted([{ name: "worker", strategy: "jqs" }], {
          "HireFire-Lease-TTL": "abc",
          "HireFire-Sample-Frequency": "soon",
        })
      configure((config) => config.dyno("worker", sampler))
      await pass(16)

      expect(at("lease")).toEqual([0, 15])
      expect(sampler).toHaveBeenCalledTimes(2)
    })

    test("keeps its dispatch pace when the server sends one that is not a positive whole number", async () => {
      answers.ingest = () => [200, "", { "HireFire-Dispatch-Frequency": "5s" }]
      configure((config) => config.dyno("worker", () => 1))
      await pass(3)

      expect(at("ingest")).toEqual([1, 2, 3])
    })

    test("takes no lease from a response that is too large to read", async () => {
      const sampler = jest.fn(() => 1)
      answers.lease = () => [
        200,
        "x".repeat(131073),
        { "HireFire-Lease-Granted": "true" },
      ]
      configure((config) => config.dyno("worker", sampler))
      await pass(1)

      expect(sampler).not.toHaveBeenCalled()
      expect(logged("E")).toEqual([
        "E [HireFire] Lease request error: RequestError: Response body exceeded 131072 bytes (status 200).",
      ])
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
        0, 1, 2, 3, 4, 5,
      ])
      expect(sampler).toHaveBeenCalledTimes(6)
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
      expect(logged("W")).toEqual([
        'W [HireFire] No config.dyno sampler is named "other", so this process samples nothing for it. ' +
          "Check the name, or select an adapter for it in the HireFire UI.",
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

    test("a lease request that fails is asked again when the lease would run out and logged once a minute", async () => {
      let down = true
      answers.lease = () => (down ? [500] : [200, "", denied()])
      configure((config) => config.dyno("worker", () => 7))
      await pass(61)

      expect(at("lease")).toEqual([0, 15, 30, 45, 60])
      expect(logged("E")).toEqual([
        "E [HireFire] Lease request error: RequestError: Lease request failed with 500 status.",
        "E [HireFire] Lease request error: RequestError: Lease request failed with 500 status. (5 failed attempts in a row)",
      ])

      down = false
      await pass(15)

      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Lease request recovered after 5 failed attempts.",
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

      expect(sampler).toHaveBeenCalledTimes(6)
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

  describe("a client that the host reset", () => {
    const { processRequestQueueTime } = require("../src/middleware")

    beforeEach(() => {
      process.env.DYNO = "web.1"
    })

    test("is not started again by a request, and starts again with configure", async () => {
      configure()
      await pass(1)
      await HireFire.reset()
      const sent = requests.length

      processRequestQueueTime(() => `t=${START + 1 - 0.25}`)
      await pass(3)

      expect(requests).toHaveLength(sent)
      expect(HireFire.configuration.buffer.flush()).toEqual({})
      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatcher stopped.",
      ])

      configure()
      processRequestQueueTime(() => `t=${START + 4 - 0.25}`)
      await pass(1)

      expect(requests.length).toBeGreaterThan(sent)
      expect(ingested("web", "rqt")).toMatchObject({ 4: [250, 1] })
      expect(logged("I")).toHaveLength(3)
    })

    test("starts again with boot", async () => {
      configure()
      await pass(0)
      await HireFire.reset()
      const sent = requests.length

      HireFire.boot()
      HireFire.configuration.logger = null
      await pass(1)

      expect(requests.length).toBeGreaterThan(sent)
    })

    test("that never ran is not started by a request either", async () => {
      await HireFire.reset()

      processRequestQueueTime(() => `t=${START - 0.25}`)
      await pass(2)

      expect(requests).toEqual([])
    })
  })

  describe("a cluster primary", () => {
    const { processRequestQueueTime } = require("../src/middleware")

    beforeEach(() => {
      process.env.DYNO = "web.1"
    })

    afterEach(() => {
      delete cluster.workers.test
    })

    test("with workers starts nothing and samples no request", async () => {
      cluster.workers.test = {}

      configure()
      processRequestQueueTime(() => `t=${START - 0.25}`)
      await pass(3)

      expect(requests).toEqual([])
      expect(log).toEqual([])
      expect(HireFire.configuration.buffer.flush()).toEqual({})
    })

    test("with workers reports when the host asks for it", async () => {
      cluster.workers.test = {}

      configure((config) => (config.forceStart = true))
      processRequestQueueTime(() => `t=${START - 0.25}`)
      await pass(1)

      expect(at("ingest")).toEqual([0, 1])
      expect(ingested("web", "rqt")).toMatchObject({ 0: [250, 1] })
    })

    test("stops at its first fork without a last request", async () => {
      configure()
      await pass(1)
      processRequestQueueTime(() => `t=${START + 1 - 0.25}`)
      const sent = requests.length

      cluster.workers.test = {}
      cluster.emit("fork", {})
      await pass(3)

      expect(requests).toHaveLength(sent)
      expect(dispatcher().running()).toBe(false)
      expect(HireFire.configuration.buffer.flush()).toEqual({})
      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatcher stopped.",
      ])
    })

    test("that the host asked to report keeps running when it forks", async () => {
      configure((config) => (config.forceStart = true))
      await pass(1)

      cluster.workers.test = {}
      cluster.emit("fork", {})
      await pass(2)

      expect(dispatcher().running()).toBe(true)
      expect(at("ingest")).toEqual([0, 1, 2, 3])
    })

    test("that never started stays quiet when it forks", async () => {
      cluster.emit("fork", {})
      await pass(1)

      expect(requests).toEqual([])
      expect(HireFire.configuration._dispatcher).toBeNull()
    })
  })

  describe("starting and stopping", () => {
    beforeEach(() => {
      process.env.DYNO = "web.1"
    })

    test("starts once, runs until it is stopped, and can be started again", async () => {
      expect(dispatcher().running()).toBe(false)
      configure()
      expect(dispatcher().running()).toBe(true)
      expect(dispatcher().start()).toBe(false)
      await pass(1)

      expect(await dispatcher().stop()).toBe(true)
      expect(dispatcher().running()).toBe(false)
      expect(await dispatcher().stop()).toBe(false)
      expect(dispatcher().start()).toBe(true)
      expect(dispatcher().running()).toBe(true)
      await pass(1)

      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatcher stopped.",
        "I [HireFire] Starting dispatcher.",
      ])
      expect(at("ingest")).toEqual([0, 1, 1, 1, 2])
    })

    test("a stop of a client that never started does nothing and logs nothing", async () => {
      configure((config) => (config.token = ""))

      expect(await dispatcher().stop()).toBe(false)
      expect(log).toEqual([])
    })

    test("a stop and a start during a stop do nothing, and a start after it starts", async () => {
      answers.ingest = () => after(2, [200])
      configure()
      await pass(0)

      const stop = dispatcher().stop()
      expect(dispatcher().running()).toBe(false)
      expect(await dispatcher().stop()).toBe(false)
      expect(dispatcher().start()).toBe(false)
      await pass(2)
      await pass(2)
      expect(await stop).toBe(true)

      expect(dispatcher().start()).toBe(true)
      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatcher stopped.",
        "I [HireFire] Starting dispatcher.",
      ])
    })

    test("a start after a stop begins at the current second and at the pace of a new client", async () => {
      answers.ingest = () => [200, "", { "HireFire-Dispatch-Frequency": "10" }]
      configure()
      await pass(3)
      await dispatcher().stop({ flush: false })
      await pass(5)
      dispatcher().start()
      await pass(0)

      expect(at("ingest")).toEqual([0, 8])
      expect(Object.keys(requests[1].body[0].metrics.rqt)).toEqual([
        String(START + 8),
      ])
    })

    test("a stop wakes the loops, so it does not wait for the next second", async () => {
      configure((config) => config.dyno("worker", () => 1))
      await pass(0)

      expect(await dispatcher().stop()).toBe(true)
      expect(jest.getTimerCount()).toBe(0)
    })

    test("a stop under a server that does not answer waits for the request in flight, then skips the final flush", async () => {
      answers.ingest = () =>
        after(5, Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      configure()
      await pass(1)
      HireFire.configuration.buffer.sample("web", "rqt", 80)

      let stopped = false
      const stop = dispatcher()
        .stop()
        .then(() => (stopped = true))
      await pass(3)
      expect(stopped).toBe(false)
      await pass(1)
      await stop

      expect(at("ingest")).toEqual([0])
      expect(logged("W")).toEqual([
        "W [HireFire] The last dispatch failed. The final flush is skipped.",
      ])
      expect(logged("E")).toEqual([
        "E [HireFire] Dispatch error: RequestError: Request timed out.",
      ])
    })

    test("a stop after a failed dispatch skips the final flush", async () => {
      answers.ingest = () => [503]
      configure()
      await pass(0)

      expect(await dispatcher().stop()).toBe(true)
      expect(at("ingest")).toEqual([0])
      expect(logged("W")).toEqual([
        "W [HireFire] The last dispatch failed. The final flush is skipped.",
      ])
    })

    test("a stop without a flush returns while a request is still waiting for its answer, and a start works at once", async () => {
      answers.ingest = () => after(3, [200])
      configure()
      await pass(0)
      expect(at("ingest")).toEqual([0])

      expect(await dispatcher().stop({ flush: false })).toBe(true)
      expect(dispatcher().running()).toBe(false)
      expect(dispatcher().start()).toBe(true)
      await pass(0)

      expect(logged("W")).toEqual([])
      expect(logged("I")).toEqual([
        "I [HireFire] Starting dispatcher.",
        "I [HireFire] Dispatcher stopped.",
        "I [HireFire] Starting dispatcher.",
      ])
      expect(at("ingest")).toEqual([0, 0])
    })

    test("a stop without a flush after a failed dispatch says nothing about a flush", async () => {
      answers.ingest = () => [503]
      configure()
      await pass(0)

      expect(await dispatcher().stop({ flush: false })).toBe(true)
      expect(logged("W")).toEqual([])
    })

    test("a stop gives up on a dispatch loop that does not end within the join timeout, and sends nothing more", async () => {
      const Dispatcher = require("../src/dispatcher")
      const timeout = Dispatcher.JOIN_TIMEOUT
      expect(timeout).toBe(5)
      Dispatcher.JOIN_TIMEOUT = 2
      try {
        answers.ingest = () => after(4, [200])
        configure()
        await pass(0)
        HireFire.configuration.buffer.sample("web", "rqt", 80)

        let stopped = false
        const stop = dispatcher()
          .stop()
          .then(() => (stopped = true))
        await pass(1)
        expect(stopped).toBe(false)
        await pass(1)
        await stop
        await pass(5)

        expect(at("ingest")).toEqual([0])
        expect(logged("W")).toEqual([
          "W [HireFire] The dispatch loop did not stop within 2 seconds. The final flush is skipped.",
        ])
        expect(logged("I")[1]).toBe("I [HireFire] Dispatcher stopped.")
        expect(logged("E")).toEqual([])
      } finally {
        Dispatcher.JOIN_TIMEOUT = timeout
      }
    })

    test("a stop does not wait for a sampler that does not return", async () => {
      answers.lease = () => granted([{ name: "worker", strategy: "jqs" }])
      configure((config) => config.dyno("worker", () => new Promise(() => {})))
      await pass(2)

      expect(await dispatcher().stop()).toBe(true)
      expect(logged("W")).toEqual([])
    })
  })

  describe("a process whose sampler is slow", () => {
    test("renews the lease and reports while a sample is still running", async () => {
      let release
      process.env.DYNO = "web.1"
      answers.lease = () =>
        granted([{ name: "worker", strategy: "jqs" }], {
          "HireFire-Lease-TTL": "5",
        })
      configure((config) =>
        config.dyno(
          "worker",
          () => new Promise((resolve) => (release = resolve)),
        ),
      )
      await pass(12)
      release(9)
      await pass(1)
      await dispatcher().stop()

      expect(at("lease")).toEqual([0, 5, 10])
      expect(at("ingest").slice(0, 13)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ])
      expect(ingested("worker", "jqs")).toEqual({ 12: 9 })
      expect(logged("W")).toEqual([])
    })

    test("gives the lease up when a sample runs for more than 60 seconds, and asks for it again when the sample returns", async () => {
      let release
      process.env.DYNO = "worker.1"
      const sampler = jest.fn(
        () => new Promise((resolve) => (release = resolve)),
      )
      answers.lease = () =>
        granted([{ name: "worker", strategy: "jqs" }], {
          "HireFire-Lease-TTL": "20",
        })
      configure((config) => config.dyno("worker", sampler))
      await pass(90)

      expect(at("lease")).toEqual([0, 20, 40, 60])
      expect(logged("W")).toEqual([
        "W [HireFire] A job queue sample round has run for more than 60 seconds. " +
          "The lease is released so that another process can sample.",
      ])

      release(9)
      await pass(2)
      await dispatcher().stop()

      expect(at("lease")).toEqual([0, 20, 40, 60, 91])
      expect(sampler).toHaveBeenCalledTimes(2)
      expect(ingested("worker", "jqs")).toEqual({})
      expect(logged("W")).toHaveLength(1)
    })

    test("sends the trace of a sample that ends while a dispatch waits for its answer", async () => {
      process.env.DYNO = "web.1"
      answers.lease = () => [
        200,
        JSON.stringify({
          trace: true,
          job_queues: [{ name: "worker", strategy: "jqs" }],
        }),
        {
          "HireFire-Lease-Granted": "true",
          "HireFire-Sample-Frequency": "30",
        },
      ]
      answers.ingest = (request) =>
        request.at === 0 ? after(1.5, [200]) : [200]
      configure((config) => config.dyno("worker", () => 7))
      await pass(4)

      const traced = requests.filter(
        (request) => request.path === "ingest" && request.body[0].sample_trace,
      )
      expect(traced).toHaveLength(1)
      expect(traced[0].body[0].sample_trace.ops).toHaveLength(1)
      expect(ingested("worker", "jqs")).toEqual({ 0: 7 })
    })
  })

  describe("a process that the plan names by adapter", () => {
    function leaseIdentities() {
      return requests
        .filter((request) => request.path === "lease")
        .map((request) => request.headers["hirefire-process-id"])
    }

    beforeEach(() => {
      process.env.DYNO = "web.1"
      for (const name of Object.keys(Plan.ADAPTERS)) delete Plan.ADAPTERS[name]
    })

    test("stays out of the race for the lease when no queue library is installed and no sampler is set", async () => {
      Plan.ADAPTERS.fake = planAdapter(
        { jobQueueSize: async () => 1 },
        { packages: ["hirefire-no-such-package"] },
      )
      configure()
      await pass(20)

      expect(at("lease")).toEqual([])
      expect(at("ingest").length).toBeGreaterThan(0)
    })

    test("a sampler that a later configure adds joins the race within a second", async () => {
      answers.lease = () => granted([{ name: "worker", strategy: "jql" }])
      configure()
      await pass(3)
      expect(at("lease")).toEqual([])

      HireFire.configure((config) => config.dyno("worker", () => 42))
      await pass(2)
      await dispatcher().stop()

      expect(at("lease")).toEqual([4])
      expect(new Set(Object.values(ingested("worker", "jql")))).toEqual(
        new Set([42]),
      )
    })

    test("joins the race when a queue library is installed, and samples through its adapter", async () => {
      const jobQueueLatency = jest.fn(async () => 4.2)
      Plan.ADAPTERS.fake = planAdapter({
        jobQueueLatency,
        jobQueueWorking: async () => 2,
      })
      answers.lease = () =>
        granted([
          {
            name: "worker",
            strategy: "jql",
            adapter: "fake",
            queues: ["default", "mailer"],
          },
        ])
      configure()
      await pass(3)
      await HireFire.configuration.dispatcher.stop()

      expect(jobQueueLatency.mock.calls).toEqual([["default", "mailer", {}]])
      expect(Object.values(ingested("worker", "jql"))).toEqual([4.2])
      expect(Object.values(ingested("worker", "wrk"))).toEqual([2])
      expect(logged("E")).toEqual([])
    })

    test("gives the lease back when it can sample no entry of the plan, says so once, and asks again under a new identity", async () => {
      Plan.ADAPTERS.fake = planAdapter(
        { jobQueueSize: async () => 1 },
        { strategies: ["jqs"] },
      )
      answers.lease = () =>
        granted(
          [
            { name: "worker", strategy: "jql", adapter: "fake" },
            { name: "mailer", strategy: "jqs", adapter: "nope" },
          ],
          { "HireFire-Lease-TTL": "5" },
        )
      configure()
      await pass(11)

      const identities = leaseIdentities()
      expect(at("lease")).toEqual([0, 5, 10])
      expect(new Set(identities).size).toBe(3)
      expect(logged("I").filter((line) => line.includes("Lease"))).toEqual([
        "I [HireFire] Lease grant dropped: this process cannot sample the plan " +
          "(no local job-queue samplers and no executable plan adapter).",
      ])
      expect(logged("E")).toEqual([])
      expect(ingested("worker", "jql")).toEqual({})
    })

    test("samples the entries it can and says once why it skips each of the others", async () => {
      Plan.ADAPTERS.fake = planAdapter(
        { jobQueueSize: async () => 6 },
        { strategies: ["jqs"] },
      )
      answers.lease = () =>
        granted(
          [
            { name: "worker", strategy: "jqs", adapter: "fake" },
            { name: "mailer", strategy: "jql", adapter: "fake" },
            { name: "clock", strategy: "jqs", adapter: "nope" },
          ],
          { "HireFire-Sample-Frequency": "1" },
        )
      configure()
      await pass(4)
      await HireFire.configuration.dispatcher.stop()

      expect(new Set(Object.values(ingested("worker", "jqs")))).toEqual(
        new Set([6]),
      )
      expect(Object.keys(ingested("worker", "jqs")).length).toBeGreaterThan(2)
      expect(ingested("mailer", "jql")).toEqual({})
      expect(logged("E")).toEqual([
        'E [HireFire] Plan adapter "fake" does not support strategy "jql" for "mailer". Entry skipped.',
        'E [HireFire] Unknown plan adapter "nope" for "clock". Entry skipped.',
      ])
    })
  })
})
