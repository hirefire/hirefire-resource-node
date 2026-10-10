const crypto = require("crypto")
const { Client, RequestError } = require("./client")
const FailureLog = require("./dispatcher/failure_log")
const Identity = require("./identity")

class Lease {
  static TTL_BOUNDS = [5, 3600]
  static SAMPLE_FREQUENCY_BOUNDS = [1, 3600]
  static MAX_JOB_QUEUES = 256

  constructor(configuration) {
    this._configuration = configuration
    this._client = new Client(configuration)
    this._processId = crypto.randomUUID()
    this._ttl = 15
    this._granted = false
    this._trace = false
    this._expiresAt = performance.now()
    this._nextSampleAt = performance.now()
    this._sampleFrequency = 15
    this._jobQueues = []
    this._planFailures = new FailureLog("Lease plan", configuration)
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

  trace() {
    return this._trace
  }

  demote() {
    this._clearGrant()
    this._expiresAt = performance.now()
  }

  async sampleIfDue(fn) {
    if (!this._granted || performance.now() < this._nextSampleAt) return

    this._nextSampleAt = performance.now() + this._sampleFrequency * 1000
    await fn()
  }

  async requestIfDue({ hold }) {
    if (performance.now() < this._expiresAt) return false

    this._expiresAt = performance.now() + this._ttl * 1000
    const response = await this._fetch()
    if (!response) return false

    const granted = response.headers["hirefire-lease-granted"] === "true"
    const grant = granted ? this._parseGrantBody(response.body) : emptyGrant()
    this._applyCadence(response)
    if (!granted || hold(grant.jobQueues)) this._applyGrant(granted, grant)
    else this._dropGrant()
    return true
  }

  close() {
    return this._client.close()
  }

  async _fetch() {
    let response
    try {
      response = await this._client.requestLease(this._processId)
    } catch (error) {
      this._clearGrant()
      throw error
    }
    if (response.ok) return response

    this._clearGrant()
    if (response.unauthorized) return null
    throw new RequestError(
      `Lease request failed with ${response.status} status.`,
    )
  }

  _applyCadence(response) {
    const frequency = response.integer("HireFire-Sample-Frequency")
    if (frequency !== null) {
      this._sampleFrequency = clamp(frequency, Lease.SAMPLE_FREQUENCY_BOUNDS)
      this._nextSampleAt = Math.min(
        this._nextSampleAt,
        performance.now() + this._sampleFrequency * 1000,
      )
    }

    const ttl = response.integer("HireFire-Lease-TTL")
    if (ttl !== null) {
      this._ttl = clamp(ttl, Lease.TTL_BOUNDS)
      this._expiresAt = performance.now() + this._ttl * 1000
    }
  }

  _applyGrant(granted, grant) {
    if (!this._granted) this._nextSampleAt = performance.now()
    this._granted = granted
    this._trace = grant.trace
    this._jobQueues = grant.jobQueues
  }

  _dropGrant() {
    this._clearGrant()
    this._processId = crypto.randomUUID()
    this._configuration._once.log(
      "info",
      "lease_grant_dropped",
      null,
      "[HireFire] Lease grant dropped: this process cannot sample the plan " +
        "(no local job-queue samplers and no executable plan adapter).",
    )
  }

  _parseGrantBody(body) {
    const failures = this._planFailures.count
    const grant = this._readGrantBody(body)
    if (this._planFailures.count === failures) this._planFailures.recovered()
    return grant
  }

  _readGrantBody(body) {
    if (body === "") return emptyGrant()

    let payload
    try {
      payload = JSON.parse(body)
    } catch {
      return this._ignorePlan("was not valid JSON")
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return this._ignorePlan("was not a JSON object")
    }

    const trace = payload.trace === true
    const entries = payload.job_queues
    if (!Array.isArray(entries)) {
      return this._ignorePlan("job_queues was not an array", trace)
    }
    return { jobQueues: this._planEntries(entries), trace }
  }

  _ignorePlan(reason, trace = false) {
    this._planFailures.record(`Lease grant body ${reason}. Plan ignored.`)
    return emptyGrant(trace)
  }

  _planEntries(entries) {
    const valid = entries.map(normalizeEntry).filter(Boolean)
    const invalid = entries.length - valid.length

    if (valid.length > Lease.MAX_JOB_QUEUES) {
      this._planFailures.record(
        `Lease plan truncated to ${Lease.MAX_JOB_QUEUES} job queue entries` +
          (invalid > 0 ? ` (${invalid} invalid also skipped)` : "") +
          ".",
      )
    } else if (invalid > 0) {
      const label = invalid === 1 ? "entry" : "entries"
      this._planFailures.record(
        `Lease plan skipped ${invalid} invalid job queue ${label}.`,
      )
    }

    return valid.slice(0, Lease.MAX_JOB_QUEUES)
  }

  _clearGrant() {
    this._granted = false
    this._trace = false
    this._jobQueues = []
  }
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null

  const name = String(entry.name ?? "").trim()
  const strategy = String(entry.strategy ?? "").trim()
  if (!name || !strategy || Buffer.byteLength(name) > Identity.MAX_NAME_BYTES) {
    return null
  }

  const normalized = { ...entry, name, strategy }
  if (Object.hasOwn(entry, "adapter")) {
    normalized.adapter = String(entry.adapter ?? "").trim()
  }
  return normalized
}

function emptyGrant(trace = false) {
  return { jobQueues: [], trace }
}

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max)
}

module.exports = Lease
