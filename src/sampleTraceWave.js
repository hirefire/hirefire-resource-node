const safeLog = require("./log")

function elapsedMs(from) {
  return Math.round((performance.now() - from) * 1000) / 1000
}

/**
 * One job-queue sample wave: monotonic start, per-op timings, finish payload for
 * sample_trace / verbose logging.
 */
class SampleTraceWave {
  static start() {
    return new SampleTraceWave()
  }

  constructor() {
    this._start = performance.now()
    this._ops = []
    this._payload = null
  }

  /**
   * Runs fn (sync or async), records one op for entry, returns fn's result.
   * @param {object} entry
   * @param {() => any | Promise<any>} fn
   */
  async measure(entry, fn) {
    const opStart = performance.now()
    const result = await fn()
    this.record(entry, elapsedMs(opStart))
    return result
  }

  /**
   * Records one op with a pre-measured duration in milliseconds.
   * @param {object} entry
   * @param {number} ms
   */
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

  /**
   * Wire payload: `{ wave_ms, ops }`.
   * Ops is a copy so later record does not mutate a previous finish handle.
   * @returns {{ wave_ms: number, ops: object[] }}
   */
  finish() {
    if (this._payload == null) {
      this._payload = {
        wave_ms: elapsedMs(this._start),
        ops: this._ops.map((op) => ({ ...op })),
      }
    }
    return this._payload
  }

  /**
   * Verbose sample timing lines (same format as the former dispatcher helper).
   * @param {{ info?: Function }} logger
   */
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
