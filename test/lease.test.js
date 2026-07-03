const { freezeTime } = require("./support")
const nock = require("nock")
const Lease = require("../src/lease")
const { RequestError } = require("../src/client")

const BASE = "https://data.hirefire.io"
const CONFIG = { token: "test-token-value" }

function grant(
  headers = {
    "HireFire-Lease-Granted": "true",
    "HireFire-Sample-Frequency": "15",
  },
) {
  return nock(BASE).post("/metrics/lease").reply(200, "", headers)
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
    await lease.requestIfDue()
    expect(lease.granted()).toBe(true)
  })

  test("denied after a poll", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "15",
    })
    await lease.requestIfDue()
    expect(lease.granted()).toBe(false)
  })

  test("updates sample frequency from the response", async () => {
    grant({
      "HireFire-Lease-Granted": "false",
      "HireFire-Sample-Frequency": "30",
    })
    await lease.requestIfDue()
    expect(lease.sampleFrequency).toBe(30)
  })

  test("updates ttl from the response", async () => {
    grant({ "HireFire-Lease-Granted": "false", "HireFire-Lease-TTL": "30" })
    await lease.requestIfDue()
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

    await lease.requestIfDue()
    await lease.requestIfDue()

    expect(calls).toBe(1)
  })

  test("silently denied on unauthorized", async () => {
    nock(BASE).post("/metrics/lease").reply(401)
    await lease.requestIfDue()
    expect(lease.granted()).toBe(false)
  })

  test("revokes a granted lease on unauthorized", async () => {
    grant()
    nock(BASE).post("/metrics/lease").reply(401)

    await lease.requestIfDue()
    expect(lease.granted()).toBe(true)

    freezeTime(1015)
    await lease.requestIfDue()
    expect(lease.granted()).toBe(false)
  })

  test("transport failure demotes and waits a full ttl", async () => {
    nock(BASE).post("/metrics/lease").replyWithError({ code: "ECONNREFUSED" })

    await expect(lease.requestIfDue()).rejects.toBeInstanceOf(RequestError)
    expect(lease.granted()).toBe(false)
    expect(lease._expiresAt).toBe(1015000) // advanced before the request: a full TTL wait

    // Not due again until the TTL elapses, so no second request is attempted.
    await lease.requestIfDue()
    expect(nock.isDone()).toBe(true)
  })

  test("transport failure revokes a granted lease", async () => {
    grant()
    await lease.requestIfDue()
    expect(lease.granted()).toBe(true)

    nock(BASE).post("/metrics/lease").replyWithError({ code: "ECONNRESET" })
    freezeTime(1015)
    await expect(lease.requestIfDue()).rejects.toBeInstanceOf(RequestError)
    expect(lease.granted()).toBe(false)
  })

  test("ttl update applies to the current window", async () => {
    grant({ "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": "30" })
    await lease.requestIfDue()
    expect(lease._expiresAt).toBe(1030000)
  })

  test("raises on a server error", async () => {
    nock(BASE).post("/metrics/lease").reply(500)
    await expect(lease.requestIfDue()).rejects.toThrow("Lease request failed")
    expect(lease.granted()).toBe(false)
  })

  test("sends the process id header", async () => {
    const scope = nock(BASE, {
      reqheaders: { "hirefire-process-id": lease.processId },
    })
      .post("/metrics/lease")
      .reply(200, "", {
        "HireFire-Lease-Granted": "false",
        "HireFire-Sample-Frequency": "15",
      })

    await lease.requestIfDue()
    expect(scope.isDone()).toBe(true)
  })

  test("a disabled lease skips the request", async () => {
    const disabled = new Lease(CONFIG, { enabled: false })
    await disabled.requestIfDue()
    expect(disabled.granted()).toBe(false)
    expect(nock.pendingMocks()).toEqual([])
  })

  test("sampleIfDue yields when granted and due", async () => {
    grant()
    await lease.requestIfDue()

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
    await lease.requestIfDue()

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(false)
  })

  test("sampleIfDue skips when not yet due", async () => {
    grant()
    await lease.requestIfDue()
    await lease.sampleIfDue(() => {})

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(false)
  })

  test("a failed sample consumes its window", async () => {
    grant()
    await lease.requestIfDue()

    await expect(
      lease.sampleIfDue(() => {
        throw new Error("boom")
      }),
    ).rejects.toThrow("boom")

    let sampled = false
    await lease.sampleIfDue(() => {
      sampled = true
    })
    expect(sampled).toBe(false) // the raising sample consumed this window
  })

  test("sampleIfDue advances nextSampleAt", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "10",
    })
    await lease.requestIfDue()
    await lease.sampleIfDue(() => {})
    expect(lease._nextSampleAt).toBe(1010000)
  })

  test("retains the sample frequency when the header is absent", async () => {
    grant({ "HireFire-Lease-Granted": "true" })
    await lease.requestIfDue()
    expect(lease.granted()).toBe(true)
    expect(lease.sampleFrequency).toBe(15) // default retained
  })

  test("clamps a garbled sample frequency to the floor", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "0", // a bad header must not sample every tick
    })
    await lease.requestIfDue()
    expect(lease.sampleFrequency).toBe(Lease.SAMPLE_FREQUENCY_BOUNDS[0])
  })

  test("clamps a garbled ttl to the floor", async () => {
    // A zero (or non-numeric) TTL must not re-request the lease every tick.
    grant({ "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": "0" })
    await lease.requestIfDue()
    expect(lease._ttl).toBe(Lease.TTL_BOUNDS[0])
  })

  test("clamps a sub-floor ttl to the floor", async () => {
    grant({ "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": "1" })
    await lease.requestIfDue()
    expect(lease._ttl).toBe(Lease.TTL_BOUNDS[0]) // a 1s TTL would churn renewals
  })

  test("clamps an over-large sample frequency to the ceiling", async () => {
    grant({
      "HireFire-Lease-Granted": "true",
      "HireFire-Sample-Frequency": "999999",
    })
    await lease.requestIfDue()
    expect(lease.sampleFrequency).toBe(Lease.SAMPLE_FREQUENCY_BOUNDS[1])
  })

  test("clamps an over-large ttl to the ceiling", async () => {
    // Without a cap a huge TTL would stop renewals, so the lease never fails over.
    grant({ "HireFire-Lease-Granted": "true", "HireFire-Lease-TTL": "999999" })
    await lease.requestIfDue()
    expect(lease._ttl).toBe(Lease.TTL_BOUNDS[1])
  })

  test("closes the underlying client", async () => {
    grant()
    await lease.requestIfDue()
    expect(lease._client._agent).not.toBeNull() // opened by the poll

    lease.close()
    expect(lease._client._agent).toBeNull()
  })

  test("grants only on a literal true", async () => {
    grant({ "HireFire-Lease-Granted": "1", "HireFire-Sample-Frequency": "15" })
    await lease.requestIfDue()
    expect(lease.granted()).toBe(false)
  })

  test("unauthorized ignores frequency and ttl headers", async () => {
    nock(BASE).post("/metrics/lease").reply(401, "", {
      "HireFire-Sample-Frequency": "99",
      "HireFire-Lease-TTL": "99",
    })

    await lease.requestIfDue()
    expect(lease.granted()).toBe(false)
    expect(lease.sampleFrequency).toBe(15) // a 401 returns before reading headers
  })
})
