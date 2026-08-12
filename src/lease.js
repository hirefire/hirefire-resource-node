const crypto = require("crypto")
const { Client, RequestError } = require("./client")
const safeLog = require("./log")

class Lease {
  static SAMPLE_FREQUENCY_BOUNDS = [1, 3600]
  static TTL_BOUNDS = [5, 3600]
  static MAX_BODY_BYTES = 16384
  static MAX_JOB_QUEUES = 64
  static MAX_NAME_BYTES = 128

  /**
   * @param {import("./configuration")} configuration
   */
  constructor(configuration) {
    this._configuration = configuration
    this._processId = crypto.randomUUID()
    this._client = new Client(configuration)
    this._ttl = 15
    this._granted = false
    this._trace = false
    this._expiresAt = performance.now()
    this._nextSampleAt = performance.now()
    this._sampleFrequency = 15
    this._jobQueues = []
    this._epoch = 0
  }

  get processId() {
    return this._processId
  }

  get sampleFrequency() {
    return this._sampleFrequency
  }

  get jobQueues() {
    return this._jobQueues
  }

  granted() {
    return this._granted
  }

  /** Whether the current grant asked the client to ship sample_trace on ingest. */
  trace() {
    return this._trace
  }

  /**
   * Drop local grant state without closing the transport. Bumps epoch so an in-flight
   * lease HTTP response cannot re-apply grant state.
   */
  demote() {
    this._epoch += 1
    this._granted = false
    this._trace = false
    this._jobQueues = []
    this._expiresAt = performance.now()
    this._nextSampleAt = performance.now()
  }

  async sampleIfDue(fn) {
    if (!this._granted || performance.now() < this._nextSampleAt) return

    this._nextSampleAt = performance.now() + this._sampleFrequency * 1000
    await fn()
  }

  /**
   * @param {{hold: (plan: object[]) => boolean}} options
   */
  async requestIfDue({ hold }) {
    if (performance.now() < this._expiresAt) return

    const epoch = this._epoch
    this._expiresAt = performance.now() + this._ttl * 1000

    let response
    try {
      response = await this._client.requestLease(this._processId)
    } catch (error) {
      if (this._epoch !== epoch) return
      this._granted = false
      this._trace = false
      this._jobQueues = []
      throw error
    }

    if (this._epoch !== epoch) return

    const status = response.statusCode
    if (status === 401) {
      this._granted = false
      this._trace = false
      this._jobQueues = []
      return
    }

    if (status < 200 || status >= 300) {
      this._granted = false
      this._trace = false
      this._jobQueues = []
      throw new RequestError(`Lease request failed with ${status} status.`)
    }

    const headers = response.headers
    let nextSampleFrequency = this._sampleFrequency
    let nextSampleAt = this._nextSampleAt

    if (headers["hirefire-sample-frequency"] !== undefined) {
      const previousFrequency = this._sampleFrequency
      nextSampleFrequency = clamp(
        toInteger(headers["hirefire-sample-frequency"]),
        Lease.SAMPLE_FREQUENCY_BOUNDS,
      )
      if (nextSampleFrequency < previousFrequency) {
        const sooner = performance.now() + nextSampleFrequency * 1000
        if (nextSampleAt > sooner) nextSampleAt = sooner
      }
    }

    let nextTtl = this._ttl
    let nextExpiresAt = this._expiresAt
    if (headers["hirefire-lease-ttl"] !== undefined) {
      nextTtl = clamp(
        toInteger(headers["hirefire-lease-ttl"]),
        Lease.TTL_BOUNDS,
      )
      nextExpiresAt = performance.now() + nextTtl * 1000
    }

    const granted = headers["hirefire-lease-granted"] === "true"
    const grantBody = granted
      ? this._parseGrantBody(response.body)
      : emptyGrantBody()

    if (this._epoch !== epoch) return

    const holdOk = !granted || hold(grantBody.job_queues)

    if (this._epoch !== epoch) return

    this._sampleFrequency = nextSampleFrequency
    this._nextSampleAt = nextSampleAt
    this._ttl = nextTtl
    this._expiresAt = nextExpiresAt

    if (granted && !holdOk) {
      this._granted = false
      this._trace = false
      this._jobQueues = []
      this._processId = crypto.randomUUID()
      safeLog(
        this._configuration.logger,
        "info",
        "[HireFire] Lease grant dropped: this process cannot sample the plan " +
          "(no local job-queue samplers and no executable plan adapter).",
      )
    } else {
      const wasGranted = this._granted
      this._granted = granted
      this._trace = granted && grantBody.trace
      this._jobQueues = grantBody.job_queues
      if (granted && !wasGranted) {
        this._nextSampleAt = performance.now()
      }
    }
  }

  /**
   * @returns {Promise<void>}
   */
  close() {
    return this._client.close()
  }

  /**
   * @returns {{ job_queues: object[], trace: boolean }}
   */
  _parseGrantBody(body) {
    if (body == null || body === "") return emptyGrantBody()

    if (Buffer.byteLength(body) > Lease.MAX_BODY_BYTES) {
      safeLog(
        this._configuration.logger,
        "error",
        `[HireFire] Lease grant body exceeded ${Lease.MAX_BODY_BYTES} bytes. Plan ignored.`,
      )
      return emptyGrantBody()
    }

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      safeLog(
        this._configuration.logger,
        "error",
        "[HireFire] Lease grant body was not valid JSON. Plan ignored.",
      )
      return emptyGrantBody()
    }

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      safeLog(
        this._configuration.logger,
        "error",
        "[HireFire] Lease grant body was not a JSON object. Plan ignored.",
      )
      return emptyGrantBody()
    }

    const trace = payload.trace === true
    const entries = payload.job_queues
    if (!Array.isArray(entries)) {
      safeLog(
        this._configuration.logger,
        "error",
        "[HireFire] Lease grant body job_queues was not an array. Plan ignored.",
      )
      return emptyGrantBody(trace)
    }

    const accepted = []
    let skipped = 0
    for (const entry of entries) {
      if (accepted.length >= Lease.MAX_JOB_QUEUES) {
        skipped += 1
        continue
      }
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        skipped += 1
        continue
      }

      const name = String(entry.name ?? "").trim()
      const strategy = String(entry.strategy ?? "").trim()
      const hasAdapter = Object.prototype.hasOwnProperty.call(entry, "adapter")
      const adapter = hasAdapter ? String(entry.adapter ?? "").trim() : null

      if (
        !name ||
        !strategy ||
        Buffer.byteLength(name) > Lease.MAX_NAME_BYTES
      ) {
        skipped += 1
        continue
      }

      const normalized = { ...entry, name, strategy }
      if (hasAdapter) normalized.adapter = adapter
      accepted.push(normalized)
    }

    if (entries.length > Lease.MAX_JOB_QUEUES) {
      safeLog(
        this._configuration.logger,
        "error",
        `[HireFire] Lease plan truncated to ${Lease.MAX_JOB_QUEUES} job queue entries` +
          (skipped > 0 ? ` (${skipped} invalid also skipped)` : "") +
          ".",
      )
    } else if (skipped > 0) {
      const label = skipped === 1 ? "entry" : "entries"
      safeLog(
        this._configuration.logger,
        "error",
        `[HireFire] Lease plan skipped ${skipped} invalid job queue ${label}.`,
      )
    }

    return { job_queues: accepted, trace }
  }
}

/** Fresh empty grant body (new job_queues array each call). */
function emptyGrantBody(trace = false) {
  return { job_queues: [], trace }
}

function toInteger(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max)
}

module.exports = Lease
