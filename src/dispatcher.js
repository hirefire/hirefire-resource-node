const { Client } = require("./client")
const Lease = require("./lease")
const Workers = require("./workers")
const safeLog = require("./log")

class Dispatcher {
  static WEB_BACKFILL_LIMIT = 60

  static PAYLOAD_SIZE_LIMIT = 65536

  static DEFAULT_DISPATCH_FREQUENCY = 1
  static MAX_DISPATCH_FREQUENCY = 30

  constructor(
    configuration,
    {
      web = null,
      workers = new Workers(configuration),
      cpu = [],
      webLiveness = true,
    } = {},
  ) {
    this._configuration = configuration
    this._web = web
    this._workers = workers
    this._cpu = cpu
    this._webLiveness = webLiveness
    this._client = new Client(configuration)
    this._lease = new Lease(configuration, { enabled: workers.any() })
    this._running = false
    this._stopping = false
    this._lastWebSecond = null
    this._webWatermark = undefined
    this._interval = 1
    this._dispatchFrequency = Dispatcher.DEFAULT_DISPATCH_FREQUENCY
    this._nextDispatchAt = null
    this._sleepers = new Set()
    this._loopPromise = null
    // Mirrors Ruby's thread.join(5).
    this._stopJoinTimeoutMs = 5000
  }

  start() {
    if (this._running || this._stopping) return false

    this._running = true

    // Two independent loops so a slow or hung worker sampler can never stall
    // web/CPU delivery. The worker loop only exists when workers are configured.
    const loops = [this._loop(() => this._dispatchTick())]
    if (this._workers.any()) {
      loops.push(this._loop(() => this._workerTick()))
    }
    this._loopPromise = Promise.all(loops)

    this._logger().info("[HireFire] Starting dispatcher.")
    return true
  }

  async stop() {
    if (!this._running) return false

    this._running = false
    this._stopping = true
    this._wakeSleepers()

    const loopPromise = this._loopPromise
    this._loopPromise = null
    await this._joinLoops(loopPromise)

    await this._guard(() => this._dispatch())

    // Close after the final dispatch, which reopens the client.
    this._client.close()
    this._lease.close()

    this._stopping = false
    this._logger().info("[HireFire] Dispatcher stopped.")
    return true
  }

  running() {
    return this._running
  }

  _loop(tick) {
    return this._runLoop(tick).catch((error) => {
      // Leave _running set (a dead Ruby thread does the same) so the other loop keeps going
      // and stop() still cleans up.
      this._logger().error(
        `[HireFire] Dispatcher loop stopped unexpectedly: ${
          error?.message ?? error
        }`,
      )
    })
  }

  // Bounded wait: a sampler parked forever must not block stop()'s final dispatch and
  // cleanup. Ruby's thread.join(5) proceeds the same way on timeout.
  _joinLoops(loopPromise) {
    if (!loopPromise) return Promise.resolve()
    return Promise.race([
      loopPromise,
      new Promise((resolve) => {
        const timer = setTimeout(resolve, this._stopJoinTimeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
  }

  async _runLoop(tick) {
    while (this._running) {
      await tick()
      if (!this._running) break
      await this._sleep(this._interval * 1000)
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      const sleeper = { resolve, timer: null }
      sleeper.timer = setTimeout(() => {
        this._sleepers.delete(sleeper)
        resolve()
      }, ms)
      if (sleeper.timer.unref) sleeper.timer.unref()
      this._sleepers.add(sleeper)
    })
  }

  _wakeSleepers() {
    for (const sleeper of this._sleepers) {
      clearTimeout(sleeper.timer)
      sleeper.resolve()
    }
    this._sleepers.clear()
  }

  async _dispatchTick() {
    for (const collector of this._cpu) {
      await this._guard(() => collector.sample())
    }
    await this._dispatchIfDue()
  }

  async _workerTick() {
    await this._guard(() => this._lease.requestIfDue())
    await this._guard(() =>
      this._lease.sampleIfDue(() => this._workers.sample()),
    )
  }

  async _dispatchIfDue() {
    // Pace off the monotonic clock (performance.now, ms) so a wall-clock step (e.g. NTP)
    // cannot skew the cadence. Sample timestamps stay wall-clock (_backfillWebSeconds),
    // which the server keys on.
    if (
      this._nextDispatchAt !== null &&
      performance.now() < this._nextDispatchAt
    )
      return

    await this._dispatch()
    this._nextDispatchAt = performance.now() + this._dispatchFrequency * 1000
  }

  async _guard(fn) {
    try {
      await fn()
    } catch (error) {
      this._logger().error(`[HireFire] ${error?.message ?? error}`)
    }
  }

  async _dispatch() {
    let data

    try {
      data = this._buffer().flush()
      const payload = this._buildPayload(data)
      if (payload.length === 0) return

      const body = JSON.stringify(payload)
      if (Buffer.byteLength(body) > Dispatcher.PAYLOAD_SIZE_LIMIT) {
        return this._dropOversizedPayload(body)
      }

      if (process.env.HIREFIRE_VERBOSE) {
        this._logger().info(`[HireFire] Dispatching metrics: ${body}`)
      }

      const response = await this._client.submitSamples(body)
      this._applyDispatchFrequency(response)
      if (this._webWatermark !== undefined)
        this._lastWebSecond = this._webWatermark
    } catch (error) {
      if (data && data.web && Object.keys(data.web).length > 0) {
        this._buffer().repopulateWeb(data.web)
      }
      this._logger().error(
        `[HireFire] Dispatch error: ${error?.message ?? error}`,
      )
    }
  }

  _applyDispatchFrequency(response) {
    if (!response || !response.headers) return

    const value = parseInt(response.headers["hirefire-dispatch-frequency"])
    if (!Number.isFinite(value) || value <= 0) return

    this._dispatchFrequency = Math.min(value, Dispatcher.MAX_DISPATCH_FREQUENCY)
  }

  _dropOversizedPayload(body) {
    if (this._webWatermark !== undefined)
      this._lastWebSecond = this._webWatermark
    this._logger().error(
      `[HireFire] Dropped metrics payload: ${Buffer.byteLength(
        body,
      )} bytes exceeds ` +
        `the ${Dispatcher.PAYLOAD_SIZE_LIMIT}-byte limit. Resuming from the current second.`,
    )
  }

  _buildPayload(data) {
    const entries = []

    if (this._web && this._webLiveness) {
      const samples = this._backfillWebSeconds(data.web)
      this._webWatermark = Math.max(...Object.keys(samples).map(Number))
      entries.push({ name: this._web.name, samples })
    } else if (this._web && Object.keys(data.web).length > 0) {
      entries.push({ name: this._web.name, samples: data.web })
    }

    entries.push(...data.workers)

    for (const [name, samples] of Object.entries(data.cpu)) {
      entries.push({ name, samples })
    }

    return entries
  }

  _backfillWebSeconds(samples) {
    const now = Math.floor(Date.now() / 1000)
    let from = this._lastWebSecond !== null ? this._lastWebSecond + 1 : now
    if (from < now - Dispatcher.WEB_BACKFILL_LIMIT)
      from = now - Dispatcher.WEB_BACKFILL_LIMIT
    if (from > now) from = now

    const result = { ...samples }
    for (let second = from; second <= now; second++) {
      if (result[second] === undefined) result[second] = []
    }
    return result
  }

  _buffer() {
    return this._configuration.buffer
  }

  _logger() {
    const logger = this._configuration.logger
    return {
      info: (message) => safeLog(logger, "info", message),
      error: (message) => safeLog(logger, "error", message),
    }
  }
}

module.exports = Dispatcher
