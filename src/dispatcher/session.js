const { Client } = require("../client")
const Lease = require("../lease")
const Once = require("../once")
const Plan = require("../plan")
const Sampler = require("../sampler")
const Payload = require("./payload")
const FailureLog = require("./failure_log")
const safeLog = require("../log")
const { formatError, verbose } = safeLog
const { RQT } = require("../strategy")

class Session {
  static PAYLOAD_SIZE_LIMIT = 131072
  static DEFAULT_DISPATCH_FREQUENCY = 1
  static MAX_DISPATCH_FREQUENCY = 30
  static BACKOFF_DOUBLINGS = 5
  static SAMPLE_ROUND_LIMIT = 60
  static TICK = 1

  constructor(configuration) {
    this._configuration = configuration
    this._client = new Client(configuration)
    this._lease = new Lease(configuration)
    this._live = true
    this._sleepers = new Set()
    this._dispatchLoop = null
    this._leaseLoop = null
    this._sampleLoop = null
    this._dispatchFrequency = Session.DEFAULT_DISPATCH_FREQUENCY
    this._nextDispatchAt = null
    this._lastRqtSecond = null
    this._pendingSampleTrace = null
    this._roundStartedAt = null
    this._dispatchFailures = new FailureLog("Dispatch", configuration)
    this._leaseFailures = new FailureLog("Lease request", configuration)
    this._payloadDrops = new FailureLog("Metrics payload", configuration)
    this._sampler = new Sampler(configuration)
    this._once = new Once(configuration)
  }

  start() {
    this._dispatchLoop = Promise.resolve().then(() =>
      this._cycle(async () => {
        this._ensureLeaseLoop()
        await this.report()
      }),
    )
    return this
  }

  get failing() {
    return this._dispatchFailures.count > 0
  }

  halt() {
    this._live = false
    for (const sleeper of this._sleepers) {
      clearTimeout(sleeper.timer)
      sleeper.wake()
    }
    this._sleepers.clear()
  }

  join(seconds) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), seconds * 1000).unref()
      this._dispatchLoop.then(() => {
        clearTimeout(timer)
        resolve(true)
      })
    })
  }

  close() {
    return this._client.close()
  }

  abandon() {
    this._dispatchLoop.then(() => this.close())
  }

  async report() {
    await this._guard(() => {
      for (const source of this._configuration.activeCpuSources()) {
        source.sample()
      }
    })
    await this._dispatchIfDue()
  }

  async renew() {
    if (this._roundOverdue()) return this._releaseOverdueRound()

    try {
      const hold = (plan) => this._sampler.canSample(plan)
      if (await this._lease.requestIfDue({ hold })) {
        this._leaseFailures.recovered()
      }
    } catch (error) {
      this._leaseFailures.failed(error)
    }
  }

  async sample() {
    await this._lease.sampleIfDue(async () => {
      this._roundStartedAt = performance.now()
      try {
        this._pendingSampleTrace = await this._sampler.round(
          this._lease.jobQueues,
          () => this._sampling(),
        )
      } finally {
        this._roundStartedAt = null
      }
    })
  }

  flush() {
    return this._dispatch({ final: true })
  }

  async _runLeaseLoop() {
    try {
      await this._cycle(async () => {
        await this.renew()
        if (this._lease.granted()) this._ensureSampleLoop()
      })
    } finally {
      await this._lease.close()
    }
  }

  async _runSampleLoop() {
    while (this._sampling()) {
      await this._guard(() => this.sample())
      await this._pause()
    }
  }

  async _cycle(pass) {
    while (this._live) {
      await this._guard(pass)
      await this._pause()
    }
  }

  _pause() {
    if (!this._live) return Promise.resolve()

    return new Promise((resolve) => {
      const sleeper = { wake: resolve }
      sleeper.timer = setTimeout(() => {
        this._sleepers.delete(sleeper)
        resolve()
      }, Session.TICK * 1000).unref()
      this._sleepers.add(sleeper)
    })
  }

  async _guard(fn) {
    try {
      await fn()
    } catch (error) {
      this._log("error", formatError(error))
    }
  }

  _ensureLeaseLoop() {
    if (this._leaseLoop || !this._enterRace()) return

    this._leaseLoop = this._runLeaseLoop()
  }

  _ensureSampleLoop() {
    if (this._sampleLoop) return

    this._sampleLoop = this._runSampleLoop().finally(() => {
      this._sampleLoop = null
    })
  }

  _sampling() {
    return this._live && this._lease.granted()
  }

  _roundOverdue() {
    const started = this._roundStartedAt
    return (
      started !== null &&
      performance.now() - started > Session.SAMPLE_ROUND_LIMIT * 1000
    )
  }

  _releaseOverdueRound() {
    if (!this._lease.granted()) return

    this._lease.demote()
    this._log(
      "warn",
      "A job queue sample round has run for more than " +
        `${Session.SAMPLE_ROUND_LIMIT} seconds. The lease is released ` +
        "so that another process can sample.",
    )
  }

  _enterRace() {
    return this._configuration.jobQueues.any() || Plan.anyLibraryLoaded()
  }

  async _dispatchIfDue() {
    if (
      this._nextDispatchAt !== null &&
      performance.now() < this._nextDispatchAt
    ) {
      return
    }

    await this._dispatch()
    this._nextDispatchAt = performance.now() + this._dispatchInterval() * 1000
  }

  _dispatchInterval() {
    const doublings = Math.min(
      this._dispatchFailures.count,
      Session.BACKOFF_DOUBLINGS,
    )
    return Math.min(
      this._dispatchFrequency * 2 ** doublings,
      Session.MAX_DISPATCH_FREQUENCY,
    )
  }

  async _dispatch({ final = false } = {}) {
    if (!final && !this._live) return

    let data
    try {
      data = this._buffer().flush()
      const trace = this._pendingSampleTrace
      const { entries, watermark } = this._buildPayload(data, trace)
      if (entries.length === 0) return

      const body = this._encode(entries)
      if (Buffer.byteLength(body) > Session.PAYLOAD_SIZE_LIMIT) {
        this._dropOversizedPayload(body, watermark, trace)
      } else {
        await this._submit(body, watermark, trace)
      }
    } catch (error) {
      if (data && this._live) this._repopulateRqt(data)
      this._dispatchFailures.failed(error)
    }
  }

  _encode(entries) {
    const body = JSON.stringify(entries)
    if (
      Buffer.byteLength(body) <= Session.PAYLOAD_SIZE_LIMIT ||
      !Payload.traced(entries)
    ) {
      return body
    }
    return JSON.stringify(Payload.withoutTrace(entries))
  }

  async _submit(body, watermark, trace) {
    if (verbose()) this._log("info", `Dispatching metrics: ${body}`)
    const response = await this._client.submitSamples(body)
    this._applyDispatchFrequency(response)

    if (response.tooLarge) {
      this._dropOversizedPayload(body, watermark, trace, true)
    } else {
      this._lastRqtSecond = watermark
      this._clearTrace(trace)
      this._payloadDrops.recovered()
    }
    this._dispatchFailures.recovered()
  }

  _repopulateRqt(data) {
    for (const [name, strategies] of Object.entries(data)) {
      if (strategies[RQT]) this._buffer().repopulate(name, RQT, strategies[RQT])
    }
  }

  _applyDispatchFrequency(response) {
    const value = response.integer("HireFire-Dispatch-Frequency")
    if (value === null) return

    this._dispatchFrequency = Math.min(value, Session.MAX_DISPATCH_FREQUENCY)
  }

  _dropOversizedPayload(body, watermark, trace, server = false) {
    this._clearTrace(trace)
    this._lastRqtSecond = watermark
    const source = server
      ? "server rejected (413)"
      : `exceeds the ${Session.PAYLOAD_SIZE_LIMIT}-byte limit`
    this._payloadDrops.record(
      `Dropped metrics payload: ${Buffer.byteLength(body)} bytes ${source}. ` +
        "Resuming from the current second.",
    )
  }

  _clearTrace(sent) {
    if (this._pendingSampleTrace === sent) this._pendingSampleTrace = null
  }

  _buildPayload(data, trace) {
    const configuration = this._configuration
    return Payload.build(
      data,
      {
        liveness: configuration.rqtEnabled ? configuration.httpName : null,
        since: this._lastRqtSecond,
        trace: this._lease.trace() ? trace : null,
      },
      (name, strategy) =>
        this._once.log(
          "error",
          "out_of_range",
          `${name}\0${strategy}`,
          `[HireFire] Omitting ${strategy} seconds of ${JSON.stringify(
            name,
          )}: a value is out of range.`,
        ),
    )
  }

  _buffer() {
    return this._configuration.buffer
  }

  _log(level, message) {
    safeLog(this._configuration.logger, level, `[HireFire] ${message}`)
  }
}

module.exports = Session
