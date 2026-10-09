"use strict"

const path = require("path")
const { monitorEventLoopDelay } = require("perf_hooks")

const RESOLUTION_MS = 10

function beyond(nanoseconds) {
  return Math.max(0, Math.round(nanoseconds / 1e3) / 1e3 - RESOLUTION_MS)
}

const library = process.env.TOOLS_LIBRARY || path.resolve(__dirname, "..", "..")

function start(role) {
  const HireFire = require(path.join(library, "src"))
  const middleware = require(path.join(library, "src", "middleware", "connect"))
  const state = {
    role,
    escaped: [],
    logLines: 0,
    messages: {},
    calls: 0,
    slow: 0,
    maxMs: 0,
  }
  process.on("unhandledRejection", (error) => {
    state.escaped.push(`unhandledRejection: ${error && error.message}`)
  })
  process.on("uncaughtException", (error) => {
    const where = String((error && error.stack) || "")
      .split("\n")
      .slice(1, 4)
      .map((line) => line.trim().replace(library, ""))
      .join(" <- ")
    state.escaped.push(
      `uncaughtException: ${error && error.message} (${where})`,
    )
  })
  const capture = (level) => (message) => {
    state.logLines += 1
    const key = `${level} ${String(message)
      .replace(/\d+(\.\d+)?/g, "N")
      .slice(0, 110)}`
    state.messages[key] = (state.messages[key] || 0) + 1
  }
  HireFire.configure((config) => {
    config.logger = {
      info: capture("I"),
      warn: capture("W"),
      error: capture("E"),
    }
    config.dyno("local", () => 11)
  })
  const delay = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
  delay.enable()

  function handle(request, response) {
    const started = performance.now()
    middleware(request, response, () => {})
    const elapsed = performance.now() - started
    state.calls += 1
    if (elapsed > state.maxMs) state.maxMs = elapsed
    if (elapsed > 1) state.slow += 1
    response.end("ok")
  }

  function sample() {
    if (global.gc) global.gc()
    const memory = process.memoryUsage()
    const resources = {}
    for (const name of process.getActiveResourcesInfo()) {
      resources[name] = (resources[name] || 0) + 1
    }
    let listeners = 0
    for (const name of process.eventNames()) {
      listeners += process.listenerCount(name)
    }
    const row = {
      role,
      pid: process.pid,
      rss_kb: Math.round(memory.rss / 1024),
      heap_used_kb: Math.round(memory.heapUsed / 1024),
      external_kb: Math.round(memory.external / 1024),
      handles: Object.values(resources).reduce((sum, count) => sum + count, 0),
      sockets: (resources.TCPSocketWrap || 0) + (resources.TLSWrap || 0),
      timers: resources.Timeout || 0,
      listeners,
      eld_mean_ms: beyond(delay.mean),
      eld_p99_ms: beyond(delay.percentile(99)),
      eld_max_ms: beyond(delay.max),
      mw_calls: state.calls,
      mw_over_1ms: state.slow,
      mw_max_ms: Math.round(state.maxMs * 1000) / 1000,
      log_lines: state.logLines,
      escaped: state.escaped.length,
      running: HireFire.configuration.dispatcher.running(),
    }
    delay.reset()
    state.maxMs = 0
    return row
  }

  async function stop() {
    const started = performance.now()
    await HireFire.configuration.dispatcher.stop()
    return Math.round(performance.now() - started) / 1000
  }

  return { state, handle, sample, stop }
}

module.exports = { start }
