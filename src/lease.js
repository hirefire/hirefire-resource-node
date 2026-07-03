const crypto = require("crypto")
const { Client, RequestError } = require("./client")

class Lease {
  // Bound server-supplied cadence: a zero or garbled header must not collapse it to a
  // per-tick storm. The floors differ: a 1s sample is tolerable, a sub-5s TTL churns renewals.
  static SAMPLE_FREQUENCY_BOUNDS = [1, 3600]
  static TTL_BOUNDS = [5, 3600]

  constructor(configuration, { enabled = true } = {}) {
    this._enabled = enabled
    this._processId = crypto.randomUUID()
    this._client = new Client(configuration)
    this._ttl = 15
    this._granted = false
    // Pace off the monotonic clock (performance.now, ms) so a wall-clock step (e.g. NTP)
    // cannot skew renewal.
    this._expiresAt = performance.now()
    this._nextSampleAt = performance.now()
    this._sampleFrequency = 15
  }

  get processId() {
    return this._processId
  }

  get sampleFrequency() {
    return this._sampleFrequency
  }

  granted() {
    return this._granted
  }

  async sampleIfDue(fn) {
    if (!this._granted || performance.now() < this._nextSampleAt) return

    this._nextSampleAt = performance.now() + this._sampleFrequency * 1000
    await fn()
  }

  async requestIfDue() {
    if (!this._enabled || performance.now() < this._expiresAt) return

    this._expiresAt = performance.now() + this._ttl * 1000

    let response
    try {
      response = await this._client.requestLease(this._processId)
    } catch (error) {
      this._granted = false
      throw error
    }

    const status = response.statusCode
    if (status === 401) {
      this._granted = false
      return
    }

    if (status < 200 || status >= 300) {
      this._granted = false
      throw new RequestError(`Lease request failed with ${status} status.`)
    }

    const headers = response.headers

    if (headers["hirefire-sample-frequency"] !== undefined) {
      this._sampleFrequency = clamp(
        toInteger(headers["hirefire-sample-frequency"]),
        Lease.SAMPLE_FREQUENCY_BOUNDS,
      )
    }

    if (headers["hirefire-lease-ttl"] !== undefined) {
      this._ttl = clamp(
        toInteger(headers["hirefire-lease-ttl"]),
        Lease.TTL_BOUNDS,
      )
      this._expiresAt = performance.now() + this._ttl * 1000
    }

    this._granted = headers["hirefire-lease-granted"] === "true"
  }

  close() {
    this._client.close()
  }
}

// Mirrors Ruby String#to_i: a leading integer, or 0 when there is none.
function toInteger(value) {
  const parsed = parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function clamp(value, [min, max]) {
  return Math.min(Math.max(value, min), max)
}

module.exports = Lease
