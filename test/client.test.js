require("./support")
const nock = require("nock")
const { Client, RequestError } = require("../src/client")
const VERSION = require("../src/version")

const BASE = "https://data.hirefire.io"
const BODY = '[{"name":"web","samples":{"1000":[]}}]'

describe("Client", () => {
  let client

  beforeEach(() => {
    client = new Client({ token: "test-token-value" })
  })

  test("submitSamples sends the payload with the agent header", async () => {
    const scope = nock(BASE, {
      reqheaders: {
        "content-type": "application/json",
        "hirefire-token": "test-token-value",
        "hirefire-agent": `Node-${VERSION}`,
      },
    })
      .post("/metrics/ingest", [{ name: "web", samples: { 1000: [] } }])
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("submitSamples returns null on unauthorized", async () => {
    nock(BASE).post("/metrics/ingest").reply(401)
    expect(await client.submitSamples(BODY)).toBeNull()
  })

  test("submitSamples raises on server error", async () => {
    nock(BASE).post("/metrics/ingest").reply(500)
    await expect(client.submitSamples(BODY)).rejects.toThrow("500")
  })

  test("submitSamples raises on an unexpected status", async () => {
    nock(BASE).post("/metrics/ingest").reply(422)
    await expect(client.submitSamples(BODY)).rejects.toThrow(
      "Unexpected response code 422",
    )
  })

  test("submitSamples raises on timeout", async () => {
    const slowClient = new Client(
      { token: "test-token-value" },
      { timeout: 0.1 },
    )
    nock(BASE).post("/metrics/ingest").delayConnection(500).reply(200)
    await expect(slowClient.submitSamples(BODY)).rejects.toThrow("timed out")
  })

  test("submitSamples raises on transport errors", async () => {
    for (const error of [
      { code: "ECONNREFUSED" },
      { code: "ENOTFOUND" },
      { code: "ECONNRESET" },
      "Some socket failure",
    ]) {
      nock(BASE).post("/metrics/ingest").replyWithError(error)
      const promise = client.submitSamples(BODY)
      await expect(promise).rejects.toBeInstanceOf(RequestError)
      await expect(promise).rejects.toThrow("Network error")
    }
  })

  test("requestLease sends the process id and token", async () => {
    const scope = nock(BASE, {
      reqheaders: {
        "hirefire-token": "test-token-value",
        "hirefire-process-id": "abc123",
      },
    })
      .post("/metrics/lease")
      .reply(200, "", {
        "HireFire-Lease-Granted": "false",
        "HireFire-Sample-Frequency": "15",
      })

    const response = await client.requestLease("abc123")

    expect(scope.isDone()).toBe(true)
    expect(response.statusCode).toBe(200)
  })

  test("requestLease raises on timeout", async () => {
    const slowClient = new Client(
      { token: "test-token-value" },
      { timeout: 0.1 },
    )
    nock(BASE).post("/metrics/lease").delayConnection(500).reply(200)
    await expect(slowClient.requestLease("abc123")).rejects.toThrow("timed out")
  })

  test("requestLease omits the agent header", async () => {
    let sentAgent = "unset"
    const scope = nock(BASE)
      .post("/metrics/lease")
      .reply(function () {
        sentAgent = this.req.headers["hirefire-agent"]
        return [200, "", { "HireFire-Lease-Granted": "false" }]
      })

    await client.requestLease("abc123")

    expect(scope.isDone()).toBe(true)
    expect(sentAgent).toBeUndefined() // ingest sends HireFire-Agent; the lease does not
  })

  test("raises without a token", async () => {
    const tokenless = new Client({ token: null })
    await expect(tokenless.submitSamples("[]")).rejects.toThrow(
      "HIREFIRE_TOKEN",
    )
  })

  test("uses a custom data url", async () => {
    process.env.HIREFIRE_DATA_URL = "https://custom.hirefire.io"
    const scope = nock("https://custom.hirefire.io")
      .post("/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("uses a custom data url over plain http", async () => {
    process.env.HIREFIRE_DATA_URL = "http://localhost:9999"
    const scope = nock("http://localhost:9999")
      .post("/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })
})
