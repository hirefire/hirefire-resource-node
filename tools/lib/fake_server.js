"use strict"

const net = require("net")

const REASONS = {
  200: "OK",
  302: "Found",
  401: "Unauthorized",
  413: "Payload Too Large",
  429: "Too Many Requests",
  500: "Internal Server Error",
  503: "Service Unavailable",
}

function grantHeaders(frequency) {
  return {
    "HireFire-Lease-Granted": "true",
    "HireFire-Lease-TTL": "5",
    "HireFire-Sample-Frequency": String(frequency),
  }
}

function hugePlan(adapter) {
  const entries = []
  for (let index = 0; index < 4000; index += 1) {
    entries.push({
      name: `queue-${index}`,
      strategy: "jqs",
      adapter,
      queues: [`q${index}`],
    })
  }
  return JSON.stringify({ job_queues: entries })
}

function scenarios(state) {
  const grant = () => ({
    status: 200,
    headers: grantHeaders(state.frequency),
    body: state.plan,
  })
  const lease = (request) => request.path === "/metrics/lease"
  const healthy = (request) => (lease(request) ? grant() : { status: 200 })
  const leaseOnly = (response) => (request) =>
    lease(request) ? response() : { status: 200 }
  const ingestOnly = (response) => (request) =>
    lease(request) ? grant() : response()
  return {
    healthy,
    stall: () => ({ then: "stall" }),
    reset: () => ({ then: "reset" }),
    close: () => ({ then: "close" }),
    garbage: () => ({
      raw: Buffer.from("\x00\xFFthis is not http\r\n\r\n", "latin1"),
      after: "close",
    }),
    drip: () => ({ status: 200, body: "x".repeat(40), drip: 1000 }),
    slow_200: (request) => ({ ...healthy(request), delay: 3000 }),
    status_302: () => ({ status: 302, headers: { Location: "/elsewhere" } }),
    status_401: () => ({ status: 401 }),
    status_413: ingestOnly(() => ({ status: 413 })),
    status_429: () => ({ status: 429, headers: { "Retry-After": "30" } }),
    status_500: () => ({ status: 500 }),
    status_503: () => ({ status: 503 }),
    lease_bad_json: leaseOnly(() => ({ ...grant(), body: "{not json" })),
    lease_wrong_shape: leaseOnly(() => ({
      ...grant(),
      body: JSON.stringify({
        job_queues: [
          1,
          "two",
          null,
          { name: 5 },
          { name: "worker", strategy: ["jqs"] },
        ],
      }),
    })),
    lease_huge_body: leaseOnly(() => ({
      ...grant(),
      body: hugePlan(state.hugeAdapter),
    })),
    lease_bad_headers: leaseOnly(() => ({
      status: 200,
      headers: {
        "HireFire-Lease-Granted": "true",
        "HireFire-Lease-TTL": "abc",
        "HireFire-Sample-Frequency": "-5",
      },
      body: state.plan,
    })),
    lease_binary_body: leaseOnly(() => ({
      ...grant(),
      body: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x7b]),
    })),
    lease_denied: leaseOnly(() => ({
      status: 200,
      headers: { "HireFire-Lease-Granted": "false", "HireFire-Lease-TTL": "5" },
    })),
  }
}

class FakeServer {
  constructor(options = {}) {
    this.state = {
      plan: JSON.stringify({
        job_queues: [{ name: "worker", strategy: "jqs" }],
      }),
      frequency: 1,
      hugeAdapter: "bullmq",
    }
    this.record = options.record !== false
    this.handler = options.handler || null
    this.mode = options.mode || "healthy"
    this.table = scenarios(this.state)
    this.requests = []
    this.counts = {}
    this.accepted = 0
    this.sockets = new Set()
    this.timers = new Set()
    this.server = net.createServer((socket) => this.accept(socket))
  }

  listen() {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        this.port = this.server.address().port
        this.url = `http://127.0.0.1:${this.port}`
        resolve(this)
      })
    })
  }

  stop() {
    for (const timer of this.timers) clearTimeout(timer)
    for (const socket of this.sockets) socket.destroy()
    return new Promise((resolve) => this.server.close(() => resolve()))
  }

  later(ms, fn) {
    const timer = setTimeout(() => {
      this.timers.delete(timer)
      fn()
    }, ms)
    this.timers.add(timer)
  }

  accept(socket) {
    this.accepted += 1
    this.sockets.add(socket)
    socket.on("close", () => this.sockets.delete(socket))
    socket.on("error", () => {})
    let pending = Buffer.alloc(0)
    let silent = false
    socket.on("data", (chunk) => {
      if (silent) return
      pending = Buffer.concat([pending, chunk])
      if (pending[0] === 0x16) {
        silent = true
        return
      }
      for (;;) {
        const end = pending.indexOf("\r\n\r\n")
        if (end === -1) return
        const head = pending.subarray(0, end).toString("latin1").split("\r\n")
        const [verb, path] = head[0].split(" ")
        const headers = head.slice(1).map((line) => {
          const colon = line.indexOf(":")
          return [line.slice(0, colon), line.slice(colon + 1).trim()]
        })
        const length = Number(
          (headers.find(([name]) => name.toLowerCase() === "content-length") ||
            [])[1] || 0,
        )
        if (pending.length < end + 4 + length) return
        const body = pending
          .subarray(end + 4, end + 4 + length)
          .toString("utf8")
        pending = pending.subarray(end + 4 + length)
        this.handle(socket, {
          at: Date.now(),
          verb,
          path,
          headers,
          body,
          port: socket.remotePort,
        })
      }
    })
  }

  handle(socket, request) {
    this.counts[request.path] = (this.counts[request.path] || 0) + 1
    if (this.record) this.requests.push(request)
    const respond = this.handler || this.table[this.mode] || this.table.healthy
    const response = respond(request)
    if (response.then === "stall") return
    if (response.then === "reset") {
      socket.resetAndDestroy()
      return
    }
    if (response.then === "close") {
      socket.destroy()
      return
    }
    if (response.raw) {
      socket.write(response.raw)
      if (response.after === "close") socket.end()
      return
    }
    const send = () => this.write(socket, response)
    if (response.delay) this.later(response.delay, send)
    else send()
  }

  write(socket, response) {
    if (socket.destroyed) return
    const body = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.body || "", "utf8")
    const lines = [
      `HTTP/1.1 ${response.status} ${REASONS[response.status] || "Status"}`,
    ]
    for (const [name, value] of Object.entries(response.headers || {})) {
      lines.push(`${name}: ${value}`)
    }
    lines.push(`Content-Length: ${body.length}`, "", "")
    socket.write(lines.join("\r\n"))
    if (!response.drip) {
      socket.write(body)
      return
    }
    let offset = 0
    const drip = () => {
      if (socket.destroyed || offset >= body.length) return
      socket.write(body.subarray(offset, offset + 1))
      offset += 1
      this.later(response.drip, drip)
    }
    drip()
  }

  snapshot() {
    return {
      accepted: this.accepted,
      open: this.sockets.size,
      counts: { ...this.counts },
    }
  }
}

if (require.main === module) {
  const server = new FakeServer({ record: process.env.TOOLS_RECORD !== "0" })
  server.listen().then(() => {
    process.send({ ready: true, port: server.port })
  })
  process.on("message", (message) => {
    const reply = (data) => process.send({ id: message.id, ...data })
    if (message.cmd === "mode") {
      server.mode = message.name
      reply({ at: Date.now() })
    } else if (message.cmd === "plan") {
      server.state.plan = message.plan
      server.state.frequency = message.frequency
      if (message.hugeAdapter) server.state.hugeAdapter = message.hugeAdapter
      reply({})
    } else if (message.cmd === "snapshot") {
      reply(server.snapshot())
    } else if (message.cmd === "requests") {
      const since = message.since || 0
      reply({
        requests: server.requests
          .filter((request) => request.at >= since)
          .map((request) =>
            message.full ? request : { at: request.at, path: request.path },
          ),
      })
    } else if (message.cmd === "stop") {
      server.stop().then(() => {
        reply({})
        process.exit(0)
      })
    }
  })
  process.on("disconnect", () => process.exit(0))
}

module.exports = { FakeServer, grantHeaders }
