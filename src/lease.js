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

  // Advances before yielding so a raising sampler costs one sample window
  // instead of being retried on every dispatcher tick.
  async sampleIfDue(fn) {
    if (!this._granted || Date.now() < this._nextSampleAt) return

    this._nextSampleAt = Date.now() + this._sampleFrequency * 1000
    await fn()
  }

  // Advances before the request so a failed renewal waits a full TTL instead of
  // blocking the dispatcher loop on every tick.
  async requestIfDue() {
    if (!this._enabled || Date.now() < this._expiresAt) return

    this._expiresAt = Date.now() + this._ttl * 1000

    let response
    try {
      response = await this._client.requestLease(this._processId)
    } catch (error) {
      // Unconfirmed leases may be re-granted to another process meanwhile; stop
      // sampling until a successful renewal rather than risk two processes
      // sampling the same fleet.
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
      this._sampleFrequency = parseInt(headers["hirefire-sample-frequency"])
    }

    if (headers["hirefire-lease-ttl"] !== undefined) {
      this._ttl = parseInt(headers["hirefire-lease-ttl"])
      this._expiresAt = Date.now() + this._ttl * 1000
    }

    this._granted = headers["hirefire-lease-granted"] === "true"
  }
}

module.exports = Lease
