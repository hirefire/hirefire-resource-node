const safeLog = require("./log")

function elapsedMs(from) {
  return Math.round((performance.now() - from) * 1000) / 1000
}

class SampleTraceWave {
  static start() {
    return new SampleTraceWave()
  }

  constructor() {
    this._start = performance.now()
    this._ops = []
    this._payload = null
  }

  async measure(entry, fn) {
    const opStart = performance.now()
    const result = await fn()
    this.record(entry, elapsedMs(opStart))
    return result
  }

  record(entry, ms) {
    this._payload = null
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      entry = {}
    }
    const queues = entry.queues
    const options = entry.options
    this._ops.push({
      adapter: entry.adapter ?? null,
      strategy: String(entry.strategy ?? ""),
      queues: Array.isArray(queues) ? queues : [],
      options:
        options && typeof options === "object" && !Array.isArray(options)
          ? options
          : {},
      ms: Math.round(Number(ms) * 1000) / 1000,
    })
    return this
  }

  finish() {
    if (this._payload == null) {
      this._payload = {
        wave_ms: elapsedMs(this._start),
        ops: this._ops.map((op) => ({ ...op })),
      }
    }
    return this._payload
  }

  logTo(logger) {
    const payload = this.finish()
    safeLog(
      logger,
      "info",
      `[HireFire] sample_job_queues wave_ms=${payload.wave_ms} ops=${payload.ops.length}`,
    )
    for (const op of payload.ops) {
      const queues = (op.queues || []).join(",")
      safeLog(
        logger,
        "info",
        `[HireFire] sample adapter=${JSON.stringify(op.adapter)} strategy=${
          op.strategy
        } queues=${queues} ms=${op.ms}`,
      )
    }
  }
}

module.exports = SampleTraceWave
