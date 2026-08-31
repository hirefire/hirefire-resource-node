const http = require("http")
const net = require("net")
const { EventEmitter } = require("events")
const nock = require("nock")
const { Client, RequestError } = require("../src/client")
const VERSION = require("../src/version")

const BASE = "https://data.hirefire.io"
const BODY = '[{"name":"web","metrics":{"rqt":{"1000":[]}}}]'

describe("Client", () => {
  let client

  beforeEach(() => {
    client = new Client({ token: "test-token-value" })
  })

  afterEach(async () => {
    if (client) await client.close()
  })

  test("submit samples sends payload", async () => {
    const scope = nock(BASE, {
      reqheaders: {
        "content-type": "application/json",
        "hirefire-token": "test-token-value",
        "hirefire-agent": `Node-${VERSION}`,
      },
    })
      .post("/metrics/ingest", [
        { name: "web", metrics: { rqt: { 1000: [] } } },
      ])
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("submit samples returns null on unauthorized", async () => {
    nock(BASE).post("/metrics/ingest").reply(401)
    expect(await client.submitSamples(BODY)).toBeNull()
  })

  test("submit samples raises on server error", async () => {
    nock(BASE).post("/metrics/ingest").reply(500)
    await expect(client.submitSamples(BODY)).rejects.toThrow("500")
  })

  test("submit samples raises on unexpected status", async () => {
    nock(BASE).post("/metrics/ingest").reply(422)
    await expect(client.submitSamples(BODY)).rejects.toThrow(
      "Unexpected response code 422",
    )
  })

  test("submit samples returns payload too large on 413", async () => {
    nock(BASE)
      .post("/metrics/ingest")
      .reply(413, { error: "payload too large" })
    const result = await client.submitSamples(BODY)
    expect(result).toBe("payload_too_large")
  })

  test("submit samples raises on timeout", async () => {
    const slowClient = new Client(
      { token: "test-token-value" },
      { timeout: 0.1 },
    )
    nock(BASE).post("/metrics/ingest").delayConnection(500).reply(200)
    try {
      await expect(slowClient.submitSamples(BODY)).rejects.toThrow("timed out")
    } finally {
      await slowClient.close()
    }
  })

  test("submit samples raises on transport errors", async () => {
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

  test("request lease sends process id", async () => {
    const scope = nock(BASE, {
      reqheaders: {
        "hirefire-token": "test-token-value",
        "hirefire-agent": `Node-${VERSION}`,
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

  test("request lease raises on timeout", async () => {
    const slowClient = new Client(
      { token: "test-token-value" },
      { timeout: 0.1 },
    )
    nock(BASE).post("/metrics/lease").delayConnection(500).reply(200)
    try {
      await expect(slowClient.requestLease("abc123")).rejects.toThrow(
        "timed out",
      )
    } finally {
      await slowClient.close()
    }
  })

  test("raises without token", async () => {
    const tokenless = new Client({ token: null })
    await expect(tokenless.submitSamples("[]")).rejects.toThrow(
      "HireFire token is not set",
    )
  })

  test("raises with empty token", async () => {
    const tokenless = new Client({ token: "" })
    await expect(tokenless.submitSamples("[]")).rejects.toThrow(
      "HireFire token is not set",
    )
  })

  test("blank and slash only data url falls back to default", async () => {
    for (const value of ["", "   ", "/", "///"]) {
      process.env.HIREFIRE_DATA_URL = value
      const scope = nock(BASE).post("/metrics/ingest").reply(200)
      await client.submitSamples(BODY)
      expect(scope.isDone()).toBe(true)
    }
  })

  test("whitespace padded data url is stripped", async () => {
    process.env.HIREFIRE_DATA_URL = "  https://custom.hirefire.io  "
    const scope = nock("https://custom.hirefire.io")
      .post("/metrics/ingest")
      .reply(200)
    await client.submitSamples(BODY)
    expect(scope.isDone()).toBe(true)
  })

  test("custom data url", async () => {
    process.env.HIREFIRE_DATA_URL = "https://custom.hirefire.io"
    const scope = nock("https://custom.hirefire.io")
      .post("/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("custom data url over plain http", async () => {
    process.env.HIREFIRE_DATA_URL = "http://localhost:9999"
    const scope = nock("http://localhost:9999")
      .post("/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("custom data url with a trailing slash does not double the path", async () => {
    process.env.HIREFIRE_DATA_URL = "https://custom.hirefire.io/prefix/"
    const scope = nock("https://custom.hirefire.io")
      .post("/prefix/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("custom data url honors a path prefix", async () => {
    process.env.HIREFIRE_DATA_URL = "https://proxy.example.com/hf"
    const scope = nock("https://proxy.example.com")
      .post("/hf/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("request lease sends the agent header", async () => {
    let sentAgent = "unset"
    const scope = nock(BASE)
      .post("/metrics/lease")
      .reply(function () {
        sentAgent = this.req.headers["hirefire-agent"]
        return [200, "", { "HireFire-Lease-Granted": "false" }]
      })

    await client.requestLease("abc123")

    expect(scope.isDone()).toBe(true)
    expect(sentAgent).toBe(`Node-${VERSION}`)
  })

  test("close is safe without a connection", async () => {
    await expect(new Client({ token: "t" }).close()).resolves.toBeUndefined()
  })

  test("rebuilds the keep alive agent when the base url scheme changes", async () => {
    nock("http://metrics.example").post("/metrics/ingest").reply(200)
    process.env.HIREFIRE_DATA_URL = "http://metrics.example"
    await client.submitSamples(BODY)

    nock("https://metrics.example").post("/metrics/ingest").reply(200)
    process.env.HIREFIRE_DATA_URL = "https://metrics.example"
    await client.submitSamples(BODY)
  })

  test("maps a socket etimedout to a timeout error", async () => {
    nock(BASE).post("/metrics/ingest").replyWithError({ code: "ETIMEDOUT" })
    await expect(client.submitSamples(BODY)).rejects.toThrow("timed out")
  })

  test("tolerates a trailing slash in the data url", async () => {
    process.env.HIREFIRE_DATA_URL = "https://custom.hirefire.io/"
    const scope = nock("https://custom.hirefire.io")
      .post("/metrics/ingest")
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("lease response body error is mapped to a request error", async () => {
    const client = new Client({ token: "t" })
    const response = new EventEmitter()
    response.resume = jest.fn()
    const request = new EventEmitter()
    request.reusedSocket = false
    request.write = jest.fn()
    request.end = jest.fn(() => {
      queueMicrotask(() =>
        response.emit("error", new Error("body stream failed")),
      )
    })
    const transport = {
      request: jest.fn((_options, callback) => {
        queueMicrotask(() => callback(response))
        return request
      }),
    }

    await expect(
      client._attempt(transport, { method: "POST" }, undefined, {
        readBody: true,
        maxBodyBytes: 10,
      }),
    ).rejects.toBeInstanceOf(RequestError)
  })
})

describe("Client (persistent connection)", () => {
  let server
  let connections = new Set()

  async function listen(handler) {
    connections = new Set()
    server = http.createServer(handler)
    server.on("connection", (socket) => {
      connections.add(socket)
      socket.on("close", () => connections.delete(socket))
    })
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
    process.env.HIREFIRE_DATA_URL = `http://127.0.0.1:${server.address().port}`
  }

  afterEach(async () => {
    for (const socket of connections) socket.destroy()
    if (server) await new Promise((resolve) => server.close(resolve))
    server = undefined
  })

  test("reuses a single connection across requests", async () => {
    await listen((req, res) => req.resume().on("end", () => res.end()))
    const client = new Client({ token: "t" })

    await client.submitSamples("[]")
    await client.submitSamples("[]")

    expect(connections.size).toBe(1)
    await client.close()
  })

  test("reconnects and retries once on a stale keep alive socket", async () => {
    let requests = 0
    await listen((req, res) => {
      requests += 1
      const attempt = requests
      req.resume().on("end", () => {
        if (attempt === 2) req.socket.destroy()
        else res.end()
      })
    })
    const client = new Client({ token: "t" })

    await client.submitSamples("[]")
    const response = await client.submitSamples("[]")

    expect(response.statusCode).toBe(200)
    expect(requests).toBe(3)
    await client.close()
  })

  test("does not retry a cold connection failure", async () => {
    let requests = 0
    await listen((req) => {
      requests += 1
      req.resume().on("end", () => req.socket.destroy())
    })
    const client = new Client({ token: "t" })

    await expect(client.submitSamples("[]")).rejects.toBeInstanceOf(
      RequestError,
    )
    expect(requests).toBe(1)
    await client.close()
  })

  test("reconnects and retries once on a desynced keep alive response", async () => {
    let requests = 0
    const raw = net.createServer((socket) => {
      let buffer = ""
      socket.on("data", (chunk) => {
        buffer += chunk.toString()
        while (buffer.includes("\r\n\r\n")) {
          buffer = buffer.slice(buffer.indexOf("\r\n\r\n") + 4)
          requests += 1
          socket.write(
            requests === 2
              ? "GARBAGE NOT HTTP\r\n\r\n"
              : "HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n",
          )
        }
      })
    })
    await new Promise((resolve) => raw.listen(0, "127.0.0.1", resolve))
    process.env.HIREFIRE_DATA_URL = `http://127.0.0.1:${raw.address().port}`
    const client = new Client({ token: "t" })

    await client.submitSamples("[]")
    const response = await client.submitSamples("[]")

    expect(response.statusCode).toBe(200)
    expect(requests).toBe(3)
    await client.close()
    await new Promise((resolve) => raw.close(resolve))
  })

  test("close finishes and clears the persistent connection", async () => {
    await listen((req, res) => req.resume().on("end", () => res.end()))
    const client = new Client({ token: "t" })
    await client.submitSamples("[]")
    expect(connections.size).toBe(1)
    const [socket] = connections
    const closed = new Promise((resolve) => socket.on("close", resolve))

    await client.close()
    await closed

    expect(connections.size).toBe(0)
  })

  test("close swallows a failing connection shutdown", async () => {
    await listen((req, res) => req.resume().on("end", () => res.end()))
    const client = new Client({ token: "t" })
    await client.submitSamples("[]")
    expect(client._agent).not.toBeNull()
    client._agent.destroy = () => {
      throw new Error("destroy boom")
    }
    await expect(client.close()).resolves.toBeUndefined()
    expect(client._agent).toBeNull()
  })

  test("does not retry twice on persistent stale errors", async () => {
    let requests = 0
    await listen((req, res) => {
      requests += 1
      req.resume().on("end", () => {
        if (requests === 1) {
          res.end()
          return
        }
        req.socket.destroy()
      })
    })
    const client = new Client({ token: "t" })

    await client.submitSamples("[]")
    await expect(client.submitSamples("[]")).rejects.toBeInstanceOf(
      RequestError,
    )
    expect(requests).toBe(3)
    await client.close()
  })

  test("response stream error is mapped to a request error", async () => {
    await listen((req, res) => {
      req.resume().on("end", () => {
        res.writeHead(200, { "Content-Length": "100" })
        res.write("partial")
        res.socket.end()
      })
    })
    const client = new Client({ token: "t" })

    const promise = client.submitSamples("[]")
    await expect(promise).rejects.toBeInstanceOf(RequestError)
    await expect(promise).rejects.toThrow(/Network error/)

    await client.close()
  })

  test("request lease returns response body string", async () => {
    await listen((req, res) => {
      req.resume().on("end", () => {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "HireFire-Lease-Granted": "true",
        })
        res.end('{"version":1,"job_queues":[]}')
      })
    })
    const client = new Client({ token: "t" })
    const response = await client.requestLease("pid-1")
    expect(response.body).toBe('{"version":1,"job_queues":[]}')
    await client.close()
  })

  test("timeout on warm socket settles once without retry", async () => {
    let requests = 0
    await listen((req, res) => {
      requests += 1
      if (requests === 1) {
        req.resume().on("end", () => res.end())
        return
      }
      req.resume()
    })
    const client = new Client({ token: "t" }, { timeout: 0.05 })

    await client.submitSamples("[]")
    await expect(client.submitSamples("[]")).rejects.toThrow("timed out")
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(requests).toBe(2)
    await client.close()
  })

  test("close waits for inflight requests", async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let arrived
    const arrival = new Promise((resolve) => {
      arrived = resolve
    })
    let completed = false
    await listen((req, res) => {
      arrived()
      req.resume().on("end", () => {
        gate.then(() => {
          completed = true
          res.end()
        })
      })
    })
    const client = new Client({ token: "t" })
    const inflight = client.submitSamples("[]")
    await arrival

    const closePromise = client.close()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(completed).toBe(false)

    release()
    await inflight
    await closePromise
    expect(completed).toBe(true)
  })
})
