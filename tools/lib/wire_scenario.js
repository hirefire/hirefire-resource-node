"use strict"

const fs = require("fs")
const path = require("path")
const { FakeServer, grantHeaders } = require("./fake_server")

const EPOCH = 1767225600
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IDENTITY_ENV = [
  "DYNO",
  "HIREFIRE_SERVICE_NAME",
  "RENDER_SERVICE_NAME",
  "RENDER_SERVICE_TYPE",
  "RENDER",
  "RENDER_CPU_COUNT",
  "HIREFIRE_VERBOSE",
]

const [name, library, output] = process.argv.slice(2)

function placeholder(value) {
  return `<${typeof value}>`
}

const SCENARIOS = {
  ingest_rqt: {
    env: { DYNO: "web.1" },
    prepare(HireFire) {
      for (const value of [25, 75, 200]) {
        HireFire.configuration.buffer.sample("web", "rqt", value)
      }
    },
    pick: { ingest: (body) => body.includes("rqt") },
  },
  ingest_rqt_idle: {
    env: { DYNO: "web.1" },
    pick: { ingest: (body) => body.includes("rqt") },
  },
  ingest_cpu: {
    env: { HIREFIRE_SERVICE_NAME: "worker" },
    pick: { ingest: (body) => body.includes("cpu") },
    normalize(payload) {
      for (const entry of payload) {
        const cpu = entry.metrics.cpu
        if (!cpu) continue
        for (const second of Object.keys(cpu)) {
          cpu[second] = placeholder(cpu[second])
        }
      }
    },
  },
  lease_local_sampler: {
    env: {},
    lease: {
      status: 200,
      headers: grantHeaders(15),
      body: JSON.stringify({
        job_queues: [{ name: "worker", strategy: "jqs" }],
      }),
    },
    configure(config) {
      config.dyno("worker", () => 42)
    },
    pick: { lease: true, ingest: (body) => body.includes("jqs") },
  },
  lease_plan_trace: {
    env: {},
    lease: {
      status: 200,
      headers: grantHeaders(1),
      body: JSON.stringify({
        trace: true,
        job_queues: [
          {
            name: "worker",
            strategy: "jqs",
            adapter: "pg_boss",
            queues: ["default"],
            options: { skip_working: true },
          },
          {
            name: "latency",
            strategy: "jql",
            adapter: "pg_boss",
            queues: ["empty"],
          },
        ],
      }),
    },
    pick: {
      lease: true,
      ingest(body) {
        const payload = JSON.parse(body)
        return (
          payload.map((entry) => entry.name).join(",") === "worker,latency" &&
          "sample_trace" in payload[0]
        )
      },
    },
    normalize(payload) {
      for (const entry of payload) {
        const trace = entry.sample_trace
        if (!trace) continue
        trace.wave_ms = placeholder(trace.wave_ms)
        for (const op of trace.ops) op.ms = placeholder(op.ms)
      }
    },
  },
}

function choose(requests, pick) {
  const found = []
  if (pick.lease) {
    const lease = requests.find((request) => request.path === "/metrics/lease")
    if (!lease) return null
    found.push(lease)
  }
  if (pick.ingest) {
    const ingest = requests.find(
      (request) =>
        request.path === "/metrics/ingest" && pick.ingest(request.body),
    )
    if (!ingest) return null
    found.push(ingest)
  }
  return found
}

function headerValue(headerName, value, normalized) {
  const lower = headerName.toLowerCase()
  if (lower === "host") return "<host>"
  if (normalized && lower === "content-length") return "<length>"
  if (lower === "hirefire-process-id" && UUID.test(value)) return "<uuid>"
  return value
}

function record(request, normalize) {
  let body = request.body
  let normalized = false
  if (normalize && request.path === "/metrics/ingest") {
    const payload = JSON.parse(body)
    normalize(payload)
    body = JSON.stringify(payload)
    normalized = true
  }
  return {
    verb: request.verb,
    path: request.path,
    headers: request.headers.map(([headerName, value]) => [
      headerName,
      headerValue(headerName, value, normalized),
    ]),
    body,
    body_normalized: normalized,
  }
}

async function main() {
  const scenario = SCENARIOS[name]
  if (!scenario) throw new Error(`unknown scenario ${name}`)
  const server = await new FakeServer({
    handler: (request) =>
      request.path === "/metrics/lease" && scenario.lease
        ? scenario.lease
        : { status: 200 },
  }).listen()
  for (const key of IDENTITY_ENV) delete process.env[key]
  Object.assign(process.env, scenario.env, {
    HIREFIRE_TOKEN: "golden-token",
    HIREFIRE_DATA_URL: server.url,
  })
  Date.now = () => EPOCH * 1000
  const HireFire = require(path.join(library, "src"))
  if (scenario.prepare) scenario.prepare(HireFire)
  HireFire.configure((config) => {
    config.logger = { info() {}, warn() {}, error() {} }
    if (scenario.configure) scenario.configure(config)
  })
  const deadline = performance.now() + 15000
  let chosen = null
  while (!chosen && performance.now() < deadline) {
    chosen = choose(server.requests, scenario.pick)
    if (!chosen) await new Promise((resolve) => setTimeout(resolve, 20))
  }
  await HireFire.configuration.dispatcher.stop({ flush: false })
  const seen = {}
  for (const request of server.requests) {
    seen[request.path] = (seen[request.path] || 0) + 1
  }
  await server.stop()
  if (!chosen) {
    console.error(
      `scenario did not produce the expected requests (saw ${JSON.stringify(
        seen,
      )})`,
    )
    process.exit(1)
  }
  fs.writeFileSync(
    output,
    JSON.stringify({
      scenario: name,
      epoch: EPOCH,
      requests: chosen.map((request) => record(request, scenario.normalize)),
    }),
  )
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
