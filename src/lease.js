const crypto = require("crypto")
const { Client, RequestError } = require("./client")

class Lease {
  constructor(configuration, { enabled = true } = {}) {
    this._enabled = enabled
    this._processId = crypto.randomUUID()
    this._client = new Client(configuration)
    this._ttl = 15
    this._granted = false
    this._expiresAt = Date.now()
    this._nextSampleAt = Date.now()
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

  // Advance before yielding so a raising sampler costs one window, not every tick.
  async sampleIfDue(fn) {
    if (!this._granted || Date.now() < this._nextSampleAt) return

    this._nextSampleAt = Date.now() + this._sampleFrequency * 1000
    await fn()
  }

  // Advance before the request so a failed renewal waits a full TTL, not every tick.
  async requestIfDue() {
    if (!this._enabled || Date.now() < this._expiresAt) return

    this._expiresAt = Date.now() + this._ttl * 1000

    let response
    try {
      response = await this._client.requestLease(this._processId)
    } catch (error) {
      // Demote on failure: an unconfirmed lease may be re-granted elsewhere, so
      // stop sampling rather than risk two processes sampling one fleet.
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

    // Guard the cadence headers: a non-positive or unparseable value keeps the
    // prior one, so NaN/0 can't collapse the interval and storm the sampler.
    const headers = response.headers

    const frequency = parseInt(headers["hirefire-sample-frequency"])
    if (Number.isFinite(frequency) && frequency > 0) {
      this._sampleFrequency = frequency
    }

    const ttl = parseInt(headers["hirefire-lease-ttl"])
    if (Number.isFinite(ttl) && ttl > 0) {
      this._ttl = ttl
      this._expiresAt = Date.now() + this._ttl * 1000
    }

    this._granted = headers["hirefire-lease-granted"] === "true"
  }
}

module.exports = Lease
