const http = require("http")
const net = require("net")
const { EventEmitter } = require("events")
const nock = require("nock")
const { Client, RequestError } = require("../src/client")
const VERSION = require("../src/version")

const BASE = "https://data.hirefire.io"
const BODY = '[{"name":"web","metrics":{"rqt":{"1000":[]}}}]'

function timed(seconds, token = "test-token-value") {
  jest.replaceProperty(Client, "TIMEOUT", seconds)
  return new Client({ token })
}

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
        "user-agent": `hirefire-resource-node/${VERSION}`,
      },
    })
      .post("/metrics/ingest", [
        { name: "web", metrics: { rqt: { 1000: [] } } },
      ])
      .reply(200)

    await client.submitSamples(BODY)

    expect(scope.isDone()).toBe(true)
  })

  test("submit samples returns the response on unauthorized", async () => {
    nock(BASE).post("/metrics/ingest").reply(401)
    const response = await client.submitSamples(BODY)
    expect(response.unauthorized).toBe(true)
    expect(response.ok).toBe(false)
    expect(response.tooLarge).toBe(false)
  })

  test("submit samples raises on server error", async () => {
    nock(BASE).post("/metrics/ingest").reply(500)
    await expect(client.submitSamples(BODY)).rejects.toThrow("500")
  })

  test("submit samples raises on unexpected status", async () => {
    nock(BASE).post("/metrics/ingest").reply(422)
    await expect(client.submitSamples(BODY)).rejects.toThrow(
      "Ingest request failed with 422 status.",
    )
  })

  test("submit samples returns the response on 413", async () => {
    nock(BASE)
      .post("/metrics/ingest")
      .reply(413, { error: "payload too large" })
    const result = await client.submitSamples(BODY)
    expect(result.tooLarge).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.unauthorized).toBe(false)
  })

  test.each([
    ["15", 15],
    [" 15 ", 15],
    ["1", 1],
    ["0", null],
    ["-5", null],
    ["1.5", null],
    ["15abc", null],
    ["soon", null],
    ["", null],
    ["1e2", null],
    ["0x10", null],
    [undefined, null],
  ])("reads the header value %j as %j", async (value, expected) => {
    const headers =
      value === undefined ? {} : { "HireFire-Dispatch-Frequency": value }
    nock(BASE).post("/metrics/ingest").reply(200, "", headers)
    const response = await client.submitSamples(BODY)
    expect(response.integer("HireFire-Dispatch-Frequency")).toBe(expected)
  })

  test("submit samples times out when the request never connects", async () => {
    process.env.HIREFIRE_DATA_URL = "http://127.0.0.1:9"
    const connect = jest
      .spyOn(net.Socket.prototype, "connect")
      .mockImplementation(function neverConnects() {
        this.connecting = true
        return this
      })
    const slowClient = timed(0.1)
    const started = Date.now()
    try {
      await expect(slowClient.submitSamples(BODY)).rejects.toThrow("timed out")
      expect(connect).toHaveBeenCalledTimes(1)
      expect(Date.now() - started).toBeLessThan(2000)
    } finally {
      connect.mockRestore()
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
        "user-agent": `hirefire-resource-node/${VERSION}`,
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
    expect(response.status).toBe(200)
  })

  test.each([
    ["a dispatch", (tokenless) => tokenless.submitSamples("[]")],
    ["a lease request", (tokenless) => tokenless.requestLease("abc123")],
  ])("%s without a token fails and sends nothing", async (_name, call) => {
    const scope = nock(BASE).post(/.*/).reply(200)

    for (const token of [null, ""]) {
      await expect(call(new Client({ token }))).rejects.toThrow(
        new RequestError(
          "HireFire token is not set.\n" +
            "Set HIREFIRE_TOKEN or config.token to enable metric dispatch.",
        ),
      )
    }
    expect(scope.isDone()).toBe(false)
  })

  test.each([200, 204, 299])(
    "a dispatch answered with %i succeeds",
    async (status) => {
      nock(BASE).post("/metrics/ingest").reply(status)

      const response = await client.submitSamples(BODY)

      expect(response.ok).toBe(true)
      expect(response.body).toBe("")
    },
  )

  test.each([300, 404, 500])(
    "a dispatch answered with %i fails with the status",
    async (status) => {
      nock(BASE).post("/metrics/ingest").reply(status)

      await expect(client.submitSamples(BODY)).rejects.toThrow(
        new RequestError(`Ingest request failed with ${status} status.`),
      )
    },
  )

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

  test.each(["data.example.com", "ftp://data.example.com", "http://", "//x"])(
    "a data url of %j fails the request with an error that names the variable",
    async (value) => {
      process.env.HIREFIRE_DATA_URL = value
      const promise = client.submitSamples(BODY)
      await expect(promise).rejects.toBeInstanceOf(RequestError)
      await expect(promise).rejects.toThrow(
        "HIREFIRE_DATA_URL must be an http or https URL with a host.",
      )
    },
  )

  test("warns about a data url that sends the token in clear text", async () => {
    const warnPlainHttpDataUrlOnce = jest.fn()
    const client = new Client({
      token: "t",
      _warnPlainHttpDataUrlOnce: warnPlainHttpDataUrlOnce,
    })
    nock("http://metrics.example:8080").post("/metrics/ingest").reply(200)
    process.env.HIREFIRE_DATA_URL = "http://metrics.example:8080"
    await client.submitSamples(BODY)

    expect(warnPlainHttpDataUrlOnce.mock.calls).toEqual([["metrics.example"]])
  })

  test.each([
    "https://metrics.example",
    "http://localhost:9999",
    "http://127.0.0.1:9999",
    "http://[::1]:9999",
  ])("does not warn about a data url of %j", async (value) => {
    const warnPlainHttpDataUrlOnce = jest.fn()
    const client = new Client({
      token: "t",
      _warnPlainHttpDataUrlOnce: warnPlainHttpDataUrlOnce,
    })
    process.env.HIREFIRE_DATA_URL = value
    await client.submitSamples(BODY).catch(() => {})

    expect(warnPlainHttpDataUrlOnce).not.toHaveBeenCalled()
  })

  test("keeps one connection pool per scheme and closes each", async () => {
    const destroy = jest.spyOn(http.Agent.prototype, "destroy")
    client = new Client({ token: "t", _warnPlainHttpDataUrlOnce() {} })
    nock("http://metrics.example").post("/metrics/ingest").reply(200)
    process.env.HIREFIRE_DATA_URL = "http://metrics.example"
    await client.submitSamples(BODY)

    nock("https://metrics.example").post("/metrics/ingest").reply(200)
    process.env.HIREFIRE_DATA_URL = "https://metrics.example"
    await client.submitSamples(BODY)
    await client.close()

    expect(destroy).toHaveBeenCalledTimes(2)
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

    expect(response.status).toBe(200)
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

    expect(response.status).toBe(200)
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
    jest.spyOn(http.Agent.prototype, "destroy").mockImplementation(() => {
      throw new Error("destroy boom")
    })

    await expect(client.close()).resolves.toBeUndefined()
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

  test("a lease response over the bound fails the request and frees the connection", async () => {
    let requests = 0
    await listen((req, res) => {
      requests += 1
      req.resume().on("end", () => {
        res.end(requests === 1 ? "x".repeat(Client.MAX_BODY_BYTES + 1) : "{}")
      })
    })
    const client = new Client({ token: "t" })

    await expect(client.requestLease("pid-1")).rejects.toThrow(
      "Response body exceeded 131072 bytes (status 200).",
    )
    expect((await client.requestLease("pid-1")).body).toBe("{}")
    await client.close()
  })

  test("a lease response of exactly the bound is read", async () => {
    await listen((req, res) => {
      req.resume().on("end", () => res.end("x".repeat(Client.MAX_BODY_BYTES)))
    })
    const client = new Client({ token: "t" })

    const response = await client.requestLease("pid-1")
    expect(response.body).toHaveLength(Client.MAX_BODY_BYTES)
    await client.close()
  })

  test("a lease response that is sent in pieces fails once it passes the bound", async () => {
    await listen((req, res) => {
      req.resume().on("end", () => {
        res.write("x".repeat(Client.MAX_BODY_BYTES))
        res.write("x")
        setTimeout(() => res.end(), 50)
      })
    })
    const client = new Client({ token: "t" })

    await expect(client.requestLease("pid-1")).rejects.toThrow(
      "Response body exceeded 131072 bytes (status 200).",
    )
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
    const client = timed(0.5, "t")

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

  test.each([
    ["a dispatch", (client) => client.submitSamples("[]")],
    ["a lease request", (client) => client.requestLease("abc123")],
  ])("%s to a server that does not answer times out", async (_name, call) => {
    await listen((req) => req.resume())
    const client = timed(0.1, "t")

    await expect(call(client)).rejects.toThrow(
      new RequestError("Request timed out."),
    )
    await client.close()
  })

  test("two requests at once share one connection", async () => {
    let opened = 0
    await listen((req, res) => req.resume().on("end", () => res.end()))
    server.on("connection", () => {
      opened += 1
    })
    const client = new Client({ token: "t" })

    await Promise.all([
      client.submitSamples("[]"),
      client.submitSamples("[]"),
      client.requestLease("abc123"),
    ])

    expect(opened).toBe(1)
    await client.close()
  })

  test("the body of a dispatch response is not read, whatever its size", async () => {
    await listen((req, res) => {
      req
        .resume()
        .on("end", () => res.end("x".repeat(Client.MAX_BODY_BYTES + 1)))
    })
    const client = new Client({ token: "t" })

    const response = await client.submitSamples("[]")

    expect(response.status).toBe(200)
    expect(response.body).toBe("")
    await client.close()
  })

  test("a lease response that announces a body over the bound fails before the body arrives", async () => {
    const sockets = []
    const raw = net.createServer((socket) => {
      sockets.push(socket)
      socket.once("data", () => {
        socket.write(
          `HTTP/1.1 200 OK\r\nContent-Length: ${
            Client.MAX_BODY_BYTES + 1
          }\r\n\r\n`,
        )
      })
    })
    await new Promise((resolve) => raw.listen(0, "127.0.0.1", resolve))
    process.env.HIREFIRE_DATA_URL = `http://127.0.0.1:${raw.address().port}`
    const client = new Client({ token: "t" })

    await expect(client.requestLease("pid-1")).rejects.toThrow(
      new RequestError("Response body exceeded 131072 bytes (status 200)."),
    )
    await client.close()
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => raw.close(resolve))
  })

  test("a lease response whose body breaks off fails as a network error", async () => {
    await listen((req, res) => {
      req.resume().on("end", () => {
        res.writeHead(200, { "Content-Length": "100" })
        res.write("partial")
        res.socket.end()
      })
    })
    const client = new Client({ token: "t" })

    const promise = client.requestLease("pid-1")
    await expect(promise).rejects.toBeInstanceOf(RequestError)
    await expect(promise).rejects.toThrow(/^Network error \(ECONNRESET: /)
    await client.close()
  })
})

describe("Client (a connection that fails)", () => {
  let attempts

  function fail(code, { reused }) {
    attempts = 0
    process.env.HIREFIRE_DATA_URL = "http://127.0.0.1:9"
    jest.spyOn(http, "request").mockImplementation((_options, callback) => {
      attempts += 1
      const attempt = attempts
      const request = new EventEmitter()
      request.reusedSocket = reused
      request.write = () => {}
      request.end = () => {
        queueMicrotask(() => {
          if (attempt === 1) {
            const error = new Error("socket failed")
            if (code) error.code = code
            request.emit("error", error)
            return
          }
          const response = new EventEmitter()
          response.statusCode = 200
          response.headers = {}
          response.resume = () => {}
          callback(response)
          queueMicrotask(() => response.emit("end"))
        })
      }
      return request
    })
    return new Client({ token: "t" })
  }

  test.each(["ECONNRESET", "ECONNABORTED", "EPIPE", "HPE_INVALID_CONSTANT"])(
    "a kept connection that fails with %s is tried once more",
    async (code) => {
      const client = fail(code, { reused: true })

      expect((await client.submitSamples("[]")).status).toBe(200)
      expect(attempts).toBe(2)
    },
  )

  test.each([
    ["ECONNREFUSED", "Network error (ECONNREFUSED: socket failed)."],
    ["ENOTFOUND", "Network error (ENOTFOUND: socket failed)."],
    [undefined, "Network error (Error: socket failed)."],
  ])(
    "a kept connection that fails with %s is not tried again",
    async (code, message) => {
      const client = fail(code, { reused: true })

      await expect(client.submitSamples("[]")).rejects.toThrow(
        new RequestError(message),
      )
      expect(attempts).toBe(1)
    },
  )

  test("a new connection that fails with ECONNRESET is not tried again", async () => {
    const client = fail("ECONNRESET", { reused: false })

    await expect(client.submitSamples("[]")).rejects.toThrow(
      new RequestError("Network error (ECONNRESET: socket failed)."),
    )
    expect(attempts).toBe(1)
  })
})

describe("Client (the deadline of 5 seconds)", () => {
  beforeEach(() => {
    jest.useFakeTimers()
    process.env.HIREFIRE_DATA_URL = "http://127.0.0.1:9"
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  function silent({ aborts }) {
    jest.spyOn(http, "request").mockImplementation((options) => {
      const request = new EventEmitter()
      request.write = () => {}
      request.end = () => {}
      if (aborts) {
        options.signal.addEventListener("abort", () => {
          const error = new Error("The operation was aborted")
          error.code = "ABORT_ERR"
          request.emit("error", error)
        })
      }
      return request
    })
  }

  async function settled(promise) {
    let state = "pending"
    promise.then(
      () => (state = "resolved"),
      (error) => (state = error.message),
    )
    await jest.advanceTimersByTimeAsync(0)
    return state
  }

  test("a request without an answer fails at 5 seconds, not before", async () => {
    silent({ aborts: true })
    const request = new Client({ token: "t" }).submitSamples("[]")

    await jest.advanceTimersByTimeAsync(4999)
    expect(await settled(request)).toBe("pending")
    await jest.advanceTimersByTimeAsync(1)
    expect(await settled(request)).toBe("Request timed out.")
  })

  test("close waits 5 seconds for a request that never ends, then returns", async () => {
    silent({ aborts: false })
    const client = new Client({ token: "t" })
    client.submitSamples("[]")
    await jest.advanceTimersByTimeAsync(0)
    const closing = client.close()

    await jest.advanceTimersByTimeAsync(4999)
    expect(await settled(closing)).toBe("pending")
    await jest.advanceTimersByTimeAsync(1)
    expect(await settled(closing)).toBe("resolved")
  })
})
