"use strict"

const fs = require("fs")
const net = require("net")
const path = require("path")
const { monitorEventLoopDelay } = require("perf_hooks")
const ServerProcess = require("./server_process")

const CONNECTION_FAULTS = ["refused", "unresolvable", "tls_to_plain"]
const [scenario, faultText, healText, output] = process.argv.slice(2)
const faultSeconds = Number(faultText)
const healSeconds = Number(healText)
const library = process.env.TOOLS_LIBRARY || path.resolve(__dirname, "..", "..")

const escaped = []
const durations = []
const log = []

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function resources() {
  const tally = {}
  for (const name of process.getActiveResourcesInfo()) {
    tally[name] = (tally[name] || 0) + 1
  }
  return tally
}

async function closedPort() {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function dataUrl(server) {
  if (scenario === "refused") return `http://127.0.0.1:${await closedPort()}`
  if (scenario === "unresolvable") return "http://nonexistent-host.invalid"
  if (scenario === "tls_to_plain") return `https://127.0.0.1:${server.port}`
  return server.url
}

async function snapshot(server) {
  const memory = process.memoryUsage()
  const remote = await server.snapshot()
  return {
    at: performance.now(),
    rss_kb: Math.round(memory.rss / 1024),
    heap_used_kb: Math.round(memory.heapUsed / 1024),
    resources: resources(),
    accepted: remote.accepted,
    open_sockets: remote.open,
    counts: remote.counts,
    log_lines: log.length,
  }
}

function socketsAndTimers(tally) {
  return {
    sockets: (tally.TCPSocketWrap || 0) + (tally.TLSWrap || 0),
    timers: tally.Timeout || 0,
  }
}

async function main() {
  process.on("unhandledRejection", (error) => {
    escaped.push(`unhandledRejection: ${error && error.message}`)
  })
  process.on("uncaughtException", (error) => {
    escaped.push(`uncaughtException: ${error && error.message}`)
  })
  const warnings = []
  process.on("warning", (warning) => warnings.push(warning.name))

  const server = await ServerProcess.start()
  const fault = CONNECTION_FAULTS.includes(scenario) ? "healthy" : scenario
  await server.mode(fault)
  process.env.HIREFIRE_TOKEN = "fault-token"
  process.env.HIREFIRE_DATA_URL = await dataUrl(server)
  process.env.DYNO = "web.1"

  const HireFire = require(path.join(library, "src"))
  const middleware = require(path.join(library, "src", "middleware", "connect"))
  const capture = (level) => (message) => log.push(`${level} ${message}`)
  try {
    HireFire.configure((config) => {
      config.logger = {
        info: capture("I"),
        warn: capture("W"),
        error: capture("E"),
      }
      config.dyno("worker", () => 7)
    })
  } catch (error) {
    escaped.push(`configure: ${error.message}`)
  }

  const delay = monitorEventLoopDelay({ resolution: 10 })
  delay.enable()
  const host = setInterval(() => {
    const request = {
      headers: { "x-request-start": `t=${Date.now() / 1000 - 0.02}` },
    }
    const started = performance.now()
    try {
      middleware(request, {}, () => {})
    } catch (error) {
      escaped.push(`middleware: ${error.message}`)
    }
    durations.push(performance.now() - started)
  }, 5)

  await sleep(1000)
  const start = await snapshot(server)
  await sleep(faultSeconds * 1000)
  const after = await snapshot(server)
  const faultLog = [...log]
  const running = HireFire.configuration.dispatcher.running()

  let healedAfter = null
  if (!CONNECTION_FAULTS.includes(scenario)) {
    const healedAt = (await server.mode("healthy")).at
    const deadline = performance.now() + healSeconds * 1000
    while (performance.now() < deadline && healedAfter === null) {
      const requests = await server.requests(healedAt)
      const first = requests.find(
        (request) =>
          request.path === "/metrics/ingest" && request.at > healedAt,
      )
      if (first) healedAfter = Math.round((first.at - healedAt) / 10) / 100
      else await sleep(50)
    }
    await sleep(1000)
    await server.mode(fault)
    await sleep(3000)
  }

  const stopStarted = performance.now()
  try {
    await HireFire.configuration.dispatcher.stop()
  } catch (error) {
    escaped.push(`stop: ${error.message}`)
  }
  const stopSeconds = Math.round((performance.now() - stopStarted) / 10) / 100
  clearInterval(host)
  delay.disable()
  await sleep(200)
  const finish = await snapshot(server)
  await server.stop()

  const seconds = (after.at - start.at) / 1000
  const sorted = [...durations].sort((a, b) => a - b)
  const messages = {}
  for (const line of faultLog) {
    const message = line
      .replace(/\d+(\.\d+)?/g, "N")
      .trim()
      .slice(0, 110)
    messages[message] = (messages[message] || 0) + 1
  }
  const levels = {}
  for (const line of faultLog) levels[line[0]] = (levels[line[0]] || 0) + 1
  const round = (value) => Math.round(value * 1000) / 1000
  const result = {
    scenario,
    fault_seconds: Math.round(seconds * 10) / 10,
    escaped,
    process_warnings: warnings,
    middleware_calls: sorted.length,
    middleware_p99_ms: round(sorted[Math.floor(sorted.length * 0.99)] || 0),
    middleware_max_ms: round(sorted[sorted.length - 1] || 0),
    event_loop_delay_mean_ms: round(Math.max(0, delay.mean / 1e6 - 10)),
    event_loop_delay_p99_ms: round(
      Math.max(0, delay.percentile(99) / 1e6 - 10),
    ),
    event_loop_delay_max_ms: round(Math.max(0, delay.max / 1e6 - 10)),
    ingest_requests: after.counts["/metrics/ingest"] || 0,
    lease_requests: after.counts["/metrics/lease"] || 0,
    connections_accepted: after.accepted,
    log_lines: faultLog.length,
    log_lines_per_minute: Math.round((faultLog.length * 60) / seconds),
    log_levels: levels,
    top_messages: Object.entries(messages)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)
      .map(([message, count]) => `${count}x ${message}`),
    dispatcher_running_after_fault: running,
    resources_start: start.resources,
    resources_after_fault: after.resources,
    resources_after_stop: finish.resources,
    sockets_start: socketsAndTimers(start.resources).sockets,
    sockets_after_fault: socketsAndTimers(after.resources).sockets,
    sockets_after_stop: socketsAndTimers(finish.resources).sockets,
    timers_after_fault: socketsAndTimers(after.resources).timers,
    rss_start_kb: start.rss_kb,
    rss_after_fault_kb: after.rss_kb,
    heap_used_start_kb: start.heap_used_kb,
    heap_used_after_fault_kb: after.heap_used_kb,
    recovered_after_seconds: healedAfter,
    stop_seconds_under_fault: stopSeconds,
  }
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + "\n")
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
