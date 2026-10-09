"use strict"

const cluster = require("cluster")
const fs = require("fs")
const http = require("http")
const path = require("path")
const ServerProcess = require("./server_process")
const { start } = require("./soak_client")

const PHASES = [
  "healthy",
  "status_500",
  "healthy",
  "stall",
  "healthy",
  "reset",
  "healthy",
  "status_401",
  "healthy",
  "garbage",
  "healthy",
  "lease_denied",
]
const PHASE_SECONDS = 20
const RESTART_EVERY = 15
const SAMPLE_EVERY = 10
const REQUESTS_PER_SECOND = 200
const PLAN = {
  job_queues: [
    {
      name: "worker",
      strategy: "jqs",
      adapter: "bullmq",
      queues: ["default", "mailers"],
      options: { skip_working: true },
    },
    {
      name: "worker-latency",
      strategy: "jql",
      adapter: "pg_boss",
      queues: ["default"],
    },
    { name: "local", strategy: "jqs" },
  ],
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

if (cluster.isWorker) {
  const client = start(process.env.TOOLS_SOAK_ROLE)
  const server = http.createServer(client.handle)
  server.listen(Number(process.env.TOOLS_SOAK_PORT), "127.0.0.1", () => {
    process.send({ type: "ready" })
  })
  process.on("message", async (message) => {
    if (message.type === "sample") {
      process.send({ type: "sample", row: client.sample() })
    } else if (message.type === "stop") {
      const seconds = await client.stop()
      process.send({
        type: "stopped",
        seconds,
        messages: client.state.messages,
        escaped: client.state.escaped,
      })
    }
  })
} else {
  main().catch((error) => {
    console.error(error)
    process.exit(1)
  })
}

function fork(role, port) {
  const worker = cluster.fork({ TOOLS_SOAK_ROLE: role, TOOLS_SOAK_PORT: port })
  const started = performance.now()
  worker.ready = new Promise((resolve) => {
    worker.on("message", (message) => {
      if (message.type === "ready") resolve(performance.now() - started)
    })
  })
  return worker
}

function ask(worker, type, reply, timeout = 30000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout)
    const listener = (message) => {
      if (message.type !== reply) return
      clearTimeout(timer)
      worker.off("message", listener)
      resolve(message)
    }
    worker.on("message", listener)
    try {
      worker.send({ type })
    } catch {
      clearTimeout(timer)
      resolve(null)
    }
  })
}

function slope(rows, key) {
  const points = rows.map((row) => [row.t / 60, row[key]])
  const count = points.length
  if (count < 3) return null
  const meanX = points.reduce((sum, [x]) => sum + x, 0) / count
  const meanY = points.reduce((sum, [, y]) => sum + y, 0) / count
  let top = 0
  let bottom = 0
  for (const [x, y] of points) {
    top += (x - meanX) * (y - meanY)
    bottom += (x - meanX) ** 2
  }
  return Math.round((top / bottom) * 10) / 10
}

async function main() {
  const seconds = Number(process.argv[2])
  const directory = process.argv[3]
  fs.mkdirSync(directory, { recursive: true })
  const server = await ServerProcess.start({ record: false })
  await server.plan(PLAN, 2)
  process.env.HIREFIRE_TOKEN = "soak-token"
  process.env.HIREFIRE_DATA_URL = server.url
  process.env.DYNO = "web.1"

  const port = await new Promise((resolve) => {
    const probe = http.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const found = probe.address().port
      probe.close(() => resolve(found))
    })
  })
  const primary = start("primary")
  let stable = fork("worker-a", port)
  let cycled = fork("worker-b", port)
  await Promise.all([stable.ready, cycled.ready])

  const agent = new http.Agent({ keepAlive: true, maxSockets: 8 })
  let sent = 0
  let failed = 0
  const load = setInterval(() => {
    for (let index = 0; index < REQUESTS_PER_SECOND / 50; index += 1) {
      const request = http.request(
        {
          host: "127.0.0.1",
          port,
          agent,
          headers: { "X-Request-Start": `t=${Date.now() / 1000 - 0.015}` },
        },
        (response) => {
          response.resume()
          sent += 1
        },
      )
      request.on("error", () => {
        failed += 1
      })
      request.end()
    }
  }, 20)

  await sleep(2000)
  const rows = []
  const restarts = []
  const exits = {}
  const started = performance.now()
  const elapsed = () => (performance.now() - started) / 1000
  let nextSample = 0
  let nextRestart = RESTART_EVERY
  let nextPhase = 0
  let phaseIndex = -1
  let phase = "healthy"
  let restarting = false

  async function sampleAll() {
    const t = Math.round(elapsed())
    const remote = await server.snapshot()
    const answers = await Promise.all([
      Promise.resolve({ row: primary.sample() }),
      ask(stable, "sample", "sample", 5000),
      ask(cycled, "sample", "sample", 5000),
    ])
    for (const answer of answers) {
      if (!answer) continue
      rows.push({
        t,
        phase,
        ...answer.row,
        restarts: restarts.length,
        server_open_sockets: remote.open,
      })
    }
  }

  while (elapsed() < seconds) {
    if (elapsed() >= nextPhase) {
      phaseIndex += 1
      phase = PHASES[phaseIndex % PHASES.length]
      await server.mode(phase)
      nextPhase += PHASE_SECONDS
    }
    if (elapsed() >= nextRestart && !restarting) {
      restarting = true
      nextRestart += RESTART_EVERY
      const old = cycled
      const killed = performance.now()
      old.once("exit", (code, signal) => {
        const key = `${code}/${signal}`
        exits[key] = (exits[key] || 0) + 1
        cycled = fork("worker-b", port)
        cycled.ready.then((readyMs) => {
          restarts.push({
            exit_ms: Math.round(performance.now() - killed - readyMs),
            ready_ms: Math.round(readyMs),
          })
          restarting = false
        })
      })
      old.process.kill("SIGTERM")
    }
    if (elapsed() >= nextSample) {
      nextSample += SAMPLE_EVERY
      await sampleAll()
    }
    await sleep(100)
  }

  await server.mode("healthy")
  await sleep(3000)
  await sampleAll()
  clearInterval(load)
  agent.destroy()
  const stopped = await ask(stable, "stop", "stopped", 40000)
  const primaryStop = await primary.stop()
  const remote = await server.snapshot()
  await server.stop()

  const columns = Object.keys(rows[0])
  fs.writeFileSync(
    path.join(directory, "soak.csv"),
    [columns.join(",")]
      .concat(rows.map((row) => columns.map((column) => row[column]).join(",")))
      .join("\n") + "\n",
  )

  const summary = {
    seconds: Math.round(elapsed()),
    phases: PHASES,
    requests_sent_to_app: sent,
    requests_failed_to_app: failed,
    server_requests: remote.counts,
    server_connections_accepted: remote.accepted,
    server_open_sockets_at_end: remote.open,
    worker_restarts: restarts.length,
    worker_exit_codes: exits,
    restart_ready_ms_median: restarts
      .map((entry) => entry.ready_ms)
      .sort((a, b) => a - b)[Math.floor(restarts.length / 2)],
    restart_ready_ms_max: Math.max(...restarts.map((entry) => entry.ready_ms)),
    stop_seconds_worker_a: stopped ? stopped.seconds : null,
    stop_seconds_primary: primaryStop,
    escaped_worker_a: stopped ? stopped.escaped : null,
    escaped_primary: primary.state.escaped,
    messages_worker_a: stopped ? stopped.messages : null,
    messages_primary: primary.state.messages,
    roles: {},
  }
  for (const role of ["primary", "worker-a"]) {
    const mine = rows.filter((row) => row.role === role)
    const settled = mine.filter((row) => row.t >= 120)
    const span = (key) => ({
      first: mine[0][key],
      last: mine[mine.length - 1][key],
      min: Math.min(...mine.map((row) => row[key])),
      max: Math.max(...mine.map((row) => row[key])),
    })
    summary.roles[role] = {
      samples: mine.length,
      rss_kb: span("rss_kb"),
      rss_slope_kb_per_minute_after_2_minutes: slope(settled, "rss_kb"),
      heap_used_kb_after_gc: span("heap_used_kb"),
      heap_slope_kb_per_minute_after_2_minutes: slope(settled, "heap_used_kb"),
      handles: span("handles"),
      sockets: span("sockets"),
      timers: span("timers"),
      listeners: span("listeners"),
      event_loop_delay_max_ms: Math.max(...mine.map((row) => row.eld_max_ms)),
      event_loop_delay_p99_ms_worst: Math.max(
        ...mine.map((row) => row.eld_p99_ms),
      ),
      middleware_calls: mine[mine.length - 1].mw_calls,
      middleware_max_ms: Math.max(...mine.map((row) => row.mw_max_ms)),
      middleware_calls_over_1_ms: mine[mine.length - 1].mw_over_1ms,
      log_lines: mine[mine.length - 1].log_lines,
      log_lines_per_minute: Math.round(
        (mine[mine.length - 1].log_lines * 60) / elapsed(),
      ),
    }
  }
  fs.writeFileSync(
    path.join(directory, "summary.json"),
    JSON.stringify(summary, null, 2) + "\n",
  )
  console.log(JSON.stringify(summary, null, 2))
  for (const worker of Object.values(cluster.workers)) worker.process.kill()
  process.exit(0)
}
