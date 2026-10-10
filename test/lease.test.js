const { freezeTime } = require("./support")
const http = require("http")
const nock = require("nock")
const Configuration = require("../src/configuration")
const Lease = require("../src/lease")
const { Client, RequestError, Response } = require("../src/client")

const BASE = "https://data.hirefire.io"
function configuration(logger = {}) {
  const config = new Configuration()
  config.token = "test-token-value"
  config.logger = { info() {}, warn() {}, error() {}, ...logger }
  return config
}

function grant(
  headers = {
    "HireFire-Lease-Granted": "true",
    "HireFire-Sample-Frequency": "15",
  },
  body = "",
) {
  return nock(BASE).post("/metrics/lease").reply(200, body, headers)
}

function holdTrue() {
  return true
}

describe("Lease", () => {
  let lease

  beforeEach(() => {
    freezeTime(1000)
    lease = new Lease(configuration())
  })

  test("process id is stable uuid", () => {
    expect(lease.processId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(lease.processId).toBe(lease.processId)
  })

  async function requested(second) {
    freezeTime(second)
    const scope = grant()
    await lease.requestIfDue({ hold: holdTrue })
    const sent = scope.isDone()
    nock.cleanAll()
    return sent
  }

  async function sampled(second) {
    if (second !== undefined) freezeTime(second)
    let ran = false
    await lease.sampleIfDue(() => {
      ran = true
    })
    return ran
  }

  test("holds no grant, no plan, and no trace before its first request", () => {
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
    expect(lease.trace()).toBe(false)
  })

  test("granted after successful poll", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.jobQueues).toEqual([])
    expect(lease.trace()).toBe(false)
  })

  test("its bounds are 5 seconds to an hour for the ttl and 1 second to an hour for a sample", () => {
    expect(Lease.TTL_BOUNDS).toEqual([5, 3600])
    expect(Lease.SAMPLE_FREQUENCY_BOUNDS).toEqual([1, 3600])
  })

  test("denied after poll", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "15",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
  })

  test("updates sample frequency from response", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(30)
  })

  test("asks again after the ttl of the response, not before", async () => {
    grant({ "HireFire-Lease-Granted": "false", "HireFire-Lease-TTL": "30" })
    await lease.requestIfDue({ hold: holdTrue })

    expect(await requested(1029.999)).toBe(false)
    expect(await requested(1030)).toBe(true)
  })

  test("asks again 15 seconds after its first request when no ttl was sent", async () => {
    grant({ "HireFire-Lease-Granted": "false" })
    await lease.requestIfDue({ hold: holdTrue })

    expect(await requested(1014.999)).toBe(false)
    expect(await requested(1015)).toBe(true)
  })

  test("not polled before interval elapsed", async () => {
    let calls = 0
    nock(BASE)
      .post("/metrics/lease")
      .reply(() => {
        calls++
        return [
          200,
          "",
          {
            "HireFire-Lease-Granted": "false",
            "HireFire-Sample-Frequency": "15",
          },
        ]
      })

    await lease.requestIfDue({ hold: holdTrue })
    await lease.requestIfDue({ hold: holdTrue })

    expect(calls).toBe(1)
  })

  test("silently denied on unauthorized", async () => {
    nock(BASE).post("/metrics/lease").reply(401)
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(false)
    expect(lease.granted()).toBe(false)
  })

  test("answers true for a request the server answered, granted or not, and false while none is due", async () => {
    grant({ "HireFire-Lease-Granted": "false" })
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(true)
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(false)

    freezeTime(1015)
    grant()
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(true)
  })

  test("a denied lease has no plan and no trace, whatever its body says", async () => {
    grant(
      { "HireFire-Lease-Granted": "false" },
      JSON.stringify({
        trace: true,
        job_queues: [{ name: "worker", strategy: "jqs" }],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })

    expect(lease.jobQueues).toEqual([])
    expect(lease.trace()).toBe(false)
  })

  test("a plan entry that is not an object with a name and a strategy is skipped", async () => {
    grant(
      { "HireFire-Lease-Granted": "true" },
      JSON.stringify({
        job_queues: [
          null,
          7,
          "worker",
          ["worker", "jqs"],
          { name: "worker", strategy: "jqs" },
        ],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })

    expect(lease.jobQueues).toEqual([{ name: "worker", strategy: "jqs" }])
  })

  test("a name of 128 bytes is kept and one of 129 bytes is skipped", async () => {
    grant(
      { "HireFire-Lease-Granted": "true" },
      JSON.stringify({
        job_queues: [
          { name: "a".repeat(128), strategy: "jqs" },
          { name: "a".repeat(129), strategy: "jqs" },
          { name: "é".repeat(64), strategy: "jqs" },
          { name: "é".repeat(64) + "a", strategy: "jqs" },
        ],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })

    expect(lease.jobQueues.map((entry) => entry.name)).toEqual([
      "a".repeat(128),
      "é".repeat(64),
    ])
  })

  test("a plan entry keeps its fields, with its name, strategy, and adapter trimmed", async () => {
    grant(
      { "HireFire-Lease-Granted": "true" },
      JSON.stringify({
        job_queues: [
          {
            name: " worker ",
            strategy: " jqs ",
            adapter: " bullmq ",
            queues: ["default"],
          },
          { name: 7, strategy: "jql" },
        ],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })

    expect(lease.jobQueues).toEqual([
      {
        name: "worker",
        strategy: "jqs",
        adapter: "bullmq",
        queues: ["default"],
      },
      { name: "7", strategy: "jql" },
    ])
  })

  test("revokes granted lease on unauthorized", async () => {
    grant()
    nock(BASE).post("/metrics/lease").reply(401)

    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)

    freezeTime(1015)
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
  })

  test("transport failure demotes and waits a full ttl", async () => {
    nock(BASE).post("/metrics/lease").replyWithError({ code: "ECONNREFUSED" })

    await expect(lease.requestIfDue({ hold: holdTrue })).rejects.toBeInstanceOf(
      RequestError,
    )
    expect(lease.granted()).toBe(false)

    expect(await requested(1014.999)).toBe(false)
    expect(await requested(1015)).toBe(true)
  })

  test("raises on server error", async () => {
    nock(BASE).post("/metrics/lease").reply(500)
    await expect(lease.requestIfDue({ hold: holdTrue })).rejects.toThrow(
      "Lease request failed",
    )
    expect(lease.granted()).toBe(false)
  })

  test("hold false drops grant without sampling", async () => {
    const body = JSON.stringify({
      version: 1,
      job_queues: [{ name: "default", strategy: "jqs", adapter: "bullmq" }],
    })
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
        "HireFire-Lease-TTL": "30",
      },
      body,
    )
    const before = lease.processId
    await lease.requestIfDue({ hold: () => false })
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
    expect(lease.processId).not.toBe(before)

    expect(await requested(1029.999)).toBe(false)
    expect(await requested(1030)).toBe(true)
  })

  test("a grant the process can no longer sample is given up with its plan and its trace", async () => {
    const body = JSON.stringify({
      trace: true,
      job_queues: [{ name: "default", strategy: "jqs", adapter: "bullmq" }],
    })
    grant({ "HireFire-Lease-Granted": "true" }, body)
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.trace()).toBe(true)
    const before = lease.processId

    freezeTime(1015)
    grant({ "HireFire-Lease-Granted": "true" }, body)
    await lease.requestIfDue({ hold: () => false })

    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
    expect(lease.trace()).toBe(false)
    expect(lease.processId).not.toBe(before)
  })

  test("a lower sample frequency pulls the next sample forward to exactly that many seconds", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(await sampled()).toBe(true)

    freezeTime(1015)
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "5",
    })
    await lease.requestIfDue({ hold: holdTrue })

    expect(lease.sampleFrequency).toBe(5)
    expect(await sampled(1019.999)).toBe(false)
    expect(await sampled(1020)).toBe(true)
  })

  test("a higher sample frequency does not push the next sample back", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(await sampled()).toBe(true)

    freezeTime(1015)
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "60",
    })
    await lease.requestIfDue({ hold: holdTrue })

    expect(await sampled(1029.999)).toBe(false)
    expect(await sampled(1030)).toBe(true)
  })

  test("demote clears the grant, keeps the identity, and makes the next request due", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    const id = lease.processId
    lease.demote()
    expect(lease.processId).toBe(id)
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])

    grant()
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(true)
    expect(lease.granted()).toBe(true)
  })

  test("a request tells whether a response was applied", async () => {
    grant()
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(true)
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(false)

    freezeTime(1015)
    grant({ "HireFire-Lease-Granted": "false" })
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(true)

    freezeTime(1030)
    grant()
    expect(await lease.requestIfDue({ hold: () => false })).toBe(true)

    freezeTime(1045)
    nock(BASE).post("/metrics/lease").reply(401)
    expect(await lease.requestIfDue({ hold: holdTrue })).toBe(false)
  })

  describe("a plan that the client cannot read", () => {
    let lines

    beforeEach(() => {
      lines = []
      lease = new Lease(
        configuration({
          info: (message) => lines.push(`I ${message}`),
          error: (message) => lines.push(`E ${message}`),
        }),
      )
    })

    async function requestAt(seconds, body) {
      freezeTime(seconds)
      grant(
        { "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": "5" },
        body,
      )
      await lease.requestIfDue({ hold: holdTrue })
    }

    test.each([
      ["not-json", "was not valid JSON"],
      ["[]", "was not a JSON object"],
      ["null", "was not a JSON object"],
      ["7", "was not a JSON object"],
      ['{"job_queues":{}}', "job_queues was not an array"],
      ["{}", "job_queues was not an array"],
    ])(
      "the body %s is ignored with one line that says it %s",
      async (body, reason) => {
        await requestAt(1000, body)

        expect(lease.granted()).toBe(true)
        expect(lease.jobQueues).toEqual([])
        expect(lines).toEqual([
          `E [HireFire] Lease grant body ${reason}. Plan ignored.`,
        ])
      },
    )

    test("is logged at once, then once a minute with a count, and a plan it can read is logged as the recovery", async () => {
      for (let second = 1000; second <= 1060; second += 5) {
        await requestAt(second, "not-json")
      }
      expect(lines).toEqual([
        "E [HireFire] Lease grant body was not valid JSON. Plan ignored.",
        "E [HireFire] Lease grant body was not valid JSON. Plan ignored. (13 failed attempts in a row)",
      ])

      await requestAt(1065, JSON.stringify({ job_queues: [] }))
      expect(lines[2]).toBe(
        "I [HireFire] Lease plan recovered after 13 failed attempts.",
      )

      await requestAt(1070, "not-json")
      expect(lines).toHaveLength(4)
    })

    test("an empty body ends a run of problems, and the body of a denied lease is not read", async () => {
      await requestAt(1000, "not-json")
      await requestAt(1005, "not-json")
      await requestAt(1010, "")
      expect(lines[1]).toBe(
        "I [HireFire] Lease plan recovered after 2 failed attempts.",
      )

      freezeTime(1015)
      grant({ "HireFire-Lease-Granted": "false" }, "not-json")
      await lease.requestIfDue({ hold: holdTrue })
      expect(lines).toHaveLength(2)
    })

    test("keeps the trace flag of a body whose plan it ignores", async () => {
      await requestAt(1000, '{"trace":true,"job_queues":"all"}')

      expect(lease.trace()).toBe(true)
      expect(lease.jobQueues).toEqual([])
    })
  })

  test("a grant after a time without one samples at once", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(await sampled()).toBe(true)
    expect(await sampled(1010)).toBe(false)

    lease.demote()
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })

    expect(await sampled()).toBe(true)
  })

  test("a renewed grant keeps its sample window", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(await sampled()).toBe(true)

    freezeTime(1015)
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })

    expect(await sampled()).toBe(false)
    expect(await sampled(1030)).toBe(true)
  })

  test("parses hyphenated job queue name", async () => {
    grant(
      { "HireFire-Lease-Granted": "true" },
      JSON.stringify({
        version: 1,
        job_queues: [{ name: "worker-latency", strategy: "jql" }],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.jobQueues).toHaveLength(1)
    expect(lease.jobQueues[0].name).toBe("worker-latency")
  })

  test("parses grant trace true", async () => {
    grant(
      { "HireFire-Lease-Granted": "true" },
      JSON.stringify({
        version: 1,
        trace: true,
        job_queues: [{ name: "worker", strategy: "jql" }],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.trace()).toBe(true)
  })

  test("trace false for string or missing", async () => {
    grant(
      { "HireFire-Lease-Granted": "true" },
      JSON.stringify({
        version: 1,
        trace: "true",
        job_queues: [],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.trace()).toBe(false)
  })

  test("a grant body over the bound fails the request", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      "x".repeat(Client.MAX_BODY_BYTES + 1),
    )
    await expect(lease.requestIfDue({ hold: holdTrue })).rejects.toThrow(
      "Response body exceeded 131072 bytes (status 200).",
    )
    expect(lease.granted()).toBe(false)
  })

  test("accepts grant body of exactly max body bytes", async () => {
    expect(Client.MAX_BODY_BYTES).toBe(131072)
    const error = jest.fn()
    lease = new Lease(configuration({ error }))
    let body = JSON.stringify({
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
    })
    body += " ".repeat(Client.MAX_BODY_BYTES - Buffer.byteLength(body))
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      body,
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues.map((entry) => entry.name)).toEqual(["worker"])
    expect(error).not.toHaveBeenCalled()
  })

  test("accepts a plan of max job queues with three queues each", async () => {
    expect(Lease.MAX_JOB_QUEUES).toBe(256)
    const error = jest.fn()
    lease = new Lease(configuration({ error }))
    const entries = Array.from({ length: Lease.MAX_JOB_QUEUES }, (_, i) => ({
      name: `background_worker_${i}`,
      strategy: "jqs",
      adapter: "bullmq",
      queues: [`critical_${i}`, `default_${i}`, `low_priority_${i}`],
      options: { skip_working: true },
    }))
    const body = JSON.stringify({ version: 1, job_queues: entries })
    expect(Buffer.byteLength(body)).toBeGreaterThan(32768)
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      body,
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues).toEqual(entries)
    expect(error).not.toHaveBeenCalled()
  })

  test("truncates plan to max job queues", async () => {
    const entries = Array.from(
      { length: Lease.MAX_JOB_QUEUES + 3 },
      (_, i) => ({
        name: `w${i}`,
        strategy: "jqs",
        adapter: null,
        queues: [],
        options: {},
      }),
    )
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({ version: 1, job_queues: entries }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues.length).toBe(Lease.MAX_JOB_QUEUES)
  })

  test("skips invalid plan entries", async () => {
    const longName = "a".repeat(128 + 1)
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [
          "not-a-hash",
          { name: "", strategy: "jqs" },
          { name: "ok", strategy: "" },
          { name: longName, strategy: "jqs" },
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
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues.length).toBe(1)
    expect(lease.jobQueues[0].name).toBe("worker")
  })

  test("json null adapter is strategy only", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jql",
            adapter: null,
            queues: ["default"],
          },
        ],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues.length).toBe(1)
    expect(lease.jobQueues[0].adapter).toBe("")
  })

  describe("a plan with more entries than the limit, or with invalid ones", () => {
    let error

    beforeEach(() => {
      error = jest.fn()
      lease = new Lease(configuration({ error }))
    })

    async function request(valid, invalid) {
      const entries = [
        ...Array.from({ length: invalid }, () => ({
          name: "",
          strategy: "jqs",
        })),
        ...Array.from({ length: valid }, (_, index) => ({
          name: `worker-${index}`,
          strategy: "jqs",
        })),
      ]
      grant(
        { "HireFire-Lease-Granted": "true" },
        JSON.stringify({ job_queues: entries }),
      )
      await lease.requestIfDue({ hold: holdTrue })
      return error.mock.calls.map((call) => call[0])
    }

    test("says that it cut the plan, and counts no valid entry as invalid", async () => {
      expect(await request(300, 0)).toEqual([
        "[HireFire] Lease plan truncated to 256 job queue entries.",
      ])
      expect(lease.jobQueues).toHaveLength(256)
      expect(lease.jobQueues[0].name).toBe("worker-0")
      expect(lease.jobQueues[255].name).toBe("worker-255")
    })

    test("names the invalid entries beside the cut", async () => {
      expect(await request(257, 3)).toEqual([
        "[HireFire] Lease plan truncated to 256 job queue entries (3 invalid also skipped).",
      ])
      expect(lease.jobQueues).toHaveLength(256)
    })

    test("names one invalid entry beside the cut", async () => {
      expect(await request(257, 1)).toEqual([
        "[HireFire] Lease plan truncated to 256 job queue entries (1 invalid also skipped).",
      ])
    })

    test("cuts nothing when the valid entries fit, however many were sent", async () => {
      expect(await request(250, 10)).toEqual([
        "[HireFire] Lease plan skipped 10 invalid job queue entries.",
      ])
      expect(lease.jobQueues).toHaveLength(250)
    })

    test("says nothing about a plan of exactly the limit", async () => {
      expect(await request(256, 0)).toEqual([])
      expect(lease.jobQueues).toHaveLength(256)
    })

    test("names one invalid entry in the singular", async () => {
      expect(await request(1, 1)).toEqual([
        "[HireFire] Lease plan skipped 1 invalid job queue entry.",
      ])
    })
  })

  test("json null name or strategy is skipped", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [
          { name: null, strategy: "jql", adapter: "bullmq" },
          { name: "mailer", strategy: null, adapter: "bullmq" },
          {
            name: "worker",
            strategy: "jqs",
            adapter: "bullmq",
            queues: ["default"],
          },
        ],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues.length).toBe(1)
    expect(lease.jobQueues[0].name).toBe("worker")
  })

  test("invalid json grant body is ignored", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      "not-json",
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.jobQueues).toEqual([])
    expect(lease.trace()).toBe(false)
  })

  test("sample if due yields when granted and due", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(true)
  })

  test("sample if due skips when not granted", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "15",
    })
    await lease.requestIfDue({ hold: holdTrue })

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(false)
  })

  test("sample if due skips when not yet due", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    let count = 0
    await lease.sampleIfDue(() => {
      count++
    })
    await lease.sampleIfDue(() => {
      count++
    })
    expect(count).toBe(1)
  })

  test("failed sample consumes its window", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })

    await expect(
      lease.sampleIfDue(() => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(false)
  })

  test("retains sample frequency when the header is absent", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(30)

    freezeTime(1015)
    grant({ "HireFire-Lease-Granted": "true" })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(30)
  })

  test("grants only on a literal true", async () => {
    grant({ "HireFire-Lease-Granted": "1", "HireFire-Sample-Frequency": "15" })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
  })

  test.each(["0", "soon", "15abc", "1.5", "-5", "", "0x10", "1e2"])(
    "ignores a sample frequency of %j",
    async (value) => {
      grant({
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": value,
      })
      await lease.requestIfDue({ hold: holdTrue })
      expect(lease.sampleFrequency).toBe(15)
    },
  )

  test("reads a sample frequency with spaces around it", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": " 20 ",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(20)
  })

  test("takes the lowest sample frequency as it is", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "1",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(1)
  })

  test("clamps an over large sample frequency to the ceiling", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "99999",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(3600)
  })

  test.each(["0", "abc", "15abc", "1.5", "-5"])(
    "ignores a ttl of %j",
    async (value) => {
      grant({ "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": value })
      await lease.requestIfDue({ hold: holdTrue })
      freezeTime(1014)
      await lease.requestIfDue({ hold: holdTrue })
      expect(nock.pendingMocks()).toEqual([])
      grant()
      freezeTime(1015)
      await lease.requestIfDue({ hold: holdTrue })
      expect(nock.isDone()).toBe(true)
    },
  )

  test("raises a ttl below the floor to the floor", async () => {
    grant({ "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": "1" })
    await lease.requestIfDue({ hold: holdTrue })
    grant()
    freezeTime(1004)
    await lease.requestIfDue({ hold: holdTrue })
    expect(nock.isDone()).toBe(false)
    freezeTime(1005)
    await lease.requestIfDue({ hold: holdTrue })
    expect(nock.isDone()).toBe(true)
  })

  test("clamps an over large ttl to the ceiling", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Lease-TTL": "99999",
    })
    await lease.requestIfDue({ hold: holdTrue })

    expect(await requested(4599.999)).toBe(false)
    expect(await requested(4600)).toBe(true)
  })

  test("close ends the connections of its client", async () => {
    const destroy = jest.spyOn(http.Agent.prototype, "destroy")
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    expect(destroy).not.toHaveBeenCalled()

    await lease.close()

    expect(destroy).toHaveBeenCalledTimes(1)
  })

  test("unauthorized ignores frequency and ttl headers", async () => {
    nock(BASE).post("/metrics/lease").reply(401, "", {
      "HireFire-Sample-Frequency": "99",
      "HireFire-Lease-TTL": "99",
    })

    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
    expect(lease.sampleFrequency).toBe(15)
    expect(await requested(1014.999)).toBe(false)
    expect(await requested(1015)).toBe(true)
  })

  test("unauthorized clears prior job queues", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [{ name: "worker", strategy: "jqs" }],
      }),
    )
    nock(BASE).post("/metrics/lease").reply(401)

    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.jobQueues.length).toBe(1)

    freezeTime(1015)
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
  })

  test("deny after grant clears job queues plan", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [
          {
            name: "worker",
            strategy: "jqs",
            adapter: "bullmq",
            queues: [],
            options: {},
          },
        ],
      }),
    )
    nock(BASE).post("/metrics/lease").reply(200, "", {
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "15",
    })

    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.jobQueues.length).toBe(1)

    freezeTime(1015)
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
  })

  test("transport failure clears prior job queues", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [{ name: "default", strategy: "jqs", adapter: "bullmq" }],
      }),
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues.length).toBe(1)

    nock(BASE).post("/metrics/lease").replyWithError({ code: "ECONNRESET" })
    freezeTime(1015)
    await expect(lease.requestIfDue({ hold: holdTrue })).rejects.toBeInstanceOf(
      RequestError,
    )
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
  })

  test("non object or non array plan body yields empty job queues", async () => {
    for (const body of [
      JSON.stringify([]),
      JSON.stringify("string"),
      JSON.stringify({ version: 1, job_queues: {} }),
    ]) {
      lease = new Lease(configuration())
      grant(
        {
          "HireFire-Lease-Granted": "true",
          "HireFire-Sample-Frequency": "15",
        },
        body,
      )
      await lease.requestIfDue({ hold: holdTrue })
      expect(lease.granted()).toBe(true)
      expect(lease.jobQueues).toEqual([])
    }
  })

  test("hold receives parsed job queues", async () => {
    const body = JSON.stringify({
      version: 1,
      job_queues: [{ name: "q", strategy: "jqs" }],
    })
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      body,
    )
    let seen
    await lease.requestIfDue({
      hold: (queues) => {
        seen = queues
        return true
      },
    })
    expect(seen[0].name).toBe("q")
  })

  test("skips single invalid entry log uses singular", async () => {
    const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
    lease = new Lease(configuration(logger))
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      JSON.stringify({
        version: 1,
        job_queues: [{ name: "", strategy: "jqs" }],
      }),
    )

    await lease.requestIfDue({ hold: holdTrue })

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("1 invalid job queue entry"),
    )
  })

  test("hold false does not re request before ttl", async () => {
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
        "HireFire-Lease-TTL": "30",
      },
      JSON.stringify({ version: 1, job_queues: [] }),
    )
    await lease.requestIfDue({ hold: () => false })
    await lease.requestIfDue({ hold: () => false })
    expect(nock.isDone()).toBe(true)
  })

  test("parse preserves queues and options", async () => {
    const body = JSON.stringify({
      version: 1,
      job_queues: [
        {
          name: " default ",
          strategy: " jqs ",
          adapter: " bullmq ",
          queues: ["a"],
          options: { x: 1 },
        },
      ],
    })
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      body,
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.jobQueues[0]).toMatchObject({
      name: "default",
      strategy: "jqs",
      adapter: "bullmq",
      queues: ["a"],
      options: { x: 1 },
    })
  })
})
