const { freezeTime } = require("./support")
const nock = require("nock")
const Lease = require("../src/lease")
const { RequestError } = require("../src/client")

const BASE = "https://data.hirefire.io"
const CONFIG = {
  token: "test-token-value",
  logger: { info() {}, warn() {}, error() {} },
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
    lease = new Lease(CONFIG)
  })

  test("process id is a stable uuid", () => {
    expect(lease.processId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    )
    expect(lease.processId).toBe(lease.processId)
  })

  test("not granted by default", () => {
    expect(lease.granted()).toBe(false)
  })

  test("granted after a successful poll", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
  })

  test("denied after a poll", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "15",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
  })

  test("updates sample frequency from the response", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(30)
  })

  test("updates ttl from the response", async () => {
    grant({ "HireFire-Lease-Granted": "false", "HireFire-Lease-TTL": "30" })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease._ttl).toBe(30)
  })

  test("not polled before the interval elapses", async () => {
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
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
  })

  test("revokes a granted lease on unauthorized", async () => {
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
    expect(lease._expiresAt).toBe(1015000)

    await lease.requestIfDue({ hold: holdTrue })
    expect(nock.isDone()).toBe(true)
  })

  test("transport failure clears job queues", async () => {
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

  test("hold false rotates process id and clears queues", async () => {
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
    expect(lease._expiresAt).toBe(1030000)
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

  test("demote does not change process id", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    const id = lease.processId
    lease.demote()
    expect(lease.processId).toBe(id)
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
  })

  test("demote during inflight discards grant", async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    nock(BASE)
      .post("/metrics/lease")
      .reply(async () => {
        await gate
        return [
          200,
          JSON.stringify({
            version: 1,
            job_queues: [{ name: "q", strategy: "jqs" }],
          }),
          {
            "HireFire-Lease-Granted": "true",
            "HireFire-Sample-Frequency": "15",
          },
        ]
      })

    const pending = lease.requestIfDue({ hold: holdTrue })
    await Promise.resolve()
    lease.demote()
    release()
    await pending
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
  })

  test("regrant rearms sample", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    await lease.sampleIfDue(() => {})
    expect(lease._nextSampleAt).toBeGreaterThan(performance.now())

    freezeTime(1030)
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    lease.demote()
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease._nextSampleAt).toBe(performance.now())
  })

  test("frequency decrease pulls next sample forward", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue({ hold: holdTrue })
    await lease.sampleIfDue(() => {})
    const late = lease._nextSampleAt

    freezeTime(1015)
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "5",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease._nextSampleAt).toBeLessThan(late)
    expect(lease.sampleFrequency).toBe(5)
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

  test("invalid json yields empty plan while granted", async () => {
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
  })

  test("oversized body is ignored", async () => {
    const huge = "x".repeat(Lease.MAX_BODY_BYTES + 1)
    grant(
      {
        "HireFire-Lease-Granted": "true",
        "HireFire-Sample-Frequency": "15",
      },
      huge,
    )
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(true)
    expect(lease.jobQueues).toEqual([])
  })

  test("hold receives queues", async () => {
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

  test("grants only on a literal true", async () => {
    grant({ "HireFire-Lease-Granted": "1", "HireFire-Sample-Frequency": "15" })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
  })

  test("unauthorized ignores frequency and ttl headers", async () => {
    nock(BASE).post("/metrics/lease").reply(401, "", {
      "HireFire-Sample-Frequency": "99",
      "HireFire-Lease-TTL": "99",
    })

    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.granted()).toBe(false)
    expect(lease.sampleFrequency).toBe(15)
  })

  test("sampleIfDue yields when granted and due", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(true)
  })

  test("sampleIfDue skips when not granted", async () => {
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

  test("a failed sample consumes its window", async () => {
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

  test("raises on a server error", async () => {
    nock(BASE).post("/metrics/lease").reply(500)
    await expect(lease.requestIfDue({ hold: holdTrue })).rejects.toThrow(
      "Lease request failed",
    )
    expect(lease.granted()).toBe(false)
  })

  test("closes the underlying client", async () => {
    grant()
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease._client._agent).not.toBeNull()

    lease.close()
    expect(lease._client._agent).toBeNull()
  })

  test("truncates plan to MAX_JOB_QUEUES", async () => {
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
    const longName = "a".repeat(Lease.MAX_NAME_BYTES + 1)
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

  test("json null adapter is strategy-only", async () => {
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

  test("clamps a garbled sample frequency to a sane floor", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "0",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(Lease.SAMPLE_FREQUENCY_BOUNDS[0])
  })

  test("clamps an over-large sample frequency to the ceiling", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "99999",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease.sampleFrequency).toBe(Lease.SAMPLE_FREQUENCY_BOUNDS[1])
  })

  test("clamps a garbled ttl to a sane floor", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Lease-TTL": "0",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease._ttl).toBe(Lease.TTL_BOUNDS[0])
  })

  test("clamps an over-large ttl to the ceiling", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Lease-TTL": "99999",
    })
    await lease.requestIfDue({ hold: holdTrue })
    expect(lease._ttl).toBe(Lease.TTL_BOUNDS[1])
  })

  test("non-object or non-array plan body yields empty job_queues", async () => {
    for (const body of [
      JSON.stringify([]),
      JSON.stringify("string"),
      JSON.stringify({ version: 1, job_queues: {} }),
    ]) {
      lease = new Lease(CONFIG)
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

  test("deny after grant clears job_queues plan", async () => {
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

  test("unauthorized clears prior job_queues", async () => {
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

  test("sampleIfDue skips when not yet due", async () => {
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

  test("demote during inflight discards late grant cadence", async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    nock(BASE)
      .post("/metrics/lease")
      .reply(async () => {
        await gate
        return [
          200,
          JSON.stringify({
            version: 1,
            job_queues: [{ name: "q", strategy: "jqs" }],
          }),
          {
            "HireFire-Lease-Granted": "true",
            "HireFire-Sample-Frequency": "30",
            "HireFire-Lease-TTL": "120",
          },
        ]
      })

    const pending = lease.requestIfDue({ hold: holdTrue })
    await Promise.resolve()
    lease.demote()
    release()
    await pending
    expect(lease.granted()).toBe(false)
    expect(lease.jobQueues).toEqual([])
    expect(lease.sampleFrequency).toBe(15)
    expect(lease._ttl).toBe(15)
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

  test("trace false when missing or non-boolean", async () => {
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
})
