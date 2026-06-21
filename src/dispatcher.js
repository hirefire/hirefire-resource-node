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
    this._sleepTimer = null
    this._sleepResolve = null
    this._loopPromise = null
  }

  start() {
    if (this._running || this._stopping) return false

    this._running = true
    this._loopPromise = this._loop().catch((error) => {
      this._running = false
      this._logger().error(
        `[HireFire] Dispatcher loop stopped unexpectedly: ${
          error?.message ?? error
        }`,
      )
    })
    this._logger().info("[HireFire] Starting dispatcher.")
    return true
  }

  async stop() {
    if (!this._running) return false

    this._running = false
    this._stopping = true
    this._wakeSleep()

    const loopPromise = this._loopPromise
    this._loopPromise = null
    await loopPromise

    await this._guard(() => this._dispatch())

    this._stopping = false
    this._logger().info("[HireFire] Dispatcher stopped.")
    return true
  }

  running() {
    return this._running
  }

  async _loop() {
    while (this._running) {
      await this._tick()
      if (!this._running) break
      await this._sleep(this._interval * 1000)
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => {
      this._sleepResolve = resolve
      this._sleepTimer = setTimeout(resolve, ms)
      if (this._sleepTimer.unref) this._sleepTimer.unref()
    })
  }

  _wakeSleep() {
    if (this._sleepTimer) {
      clearTimeout(this._sleepTimer)
      this._sleepTimer = null
    }
    if (this._sleepResolve) {
      this._sleepResolve()
      this._sleepResolve = null
    }
  }

  async _tick() {
    await this._guard(() => this._lease.requestIfDue())
    await this._guard(() =>
      this._lease.sampleIfDue(() => this._workers.sample()),
    )
    for (const collector of this._cpu) {
      await this._guard(() => collector.sample())
    }
    await this._dispatchIfDue()
  }

  async _dispatchIfDue() {
    if (this._nextDispatchAt !== null && Date.now() < this._nextDispatchAt)
      return

    await this._dispatch()
    this._nextDispatchAt = Date.now() + this._dispatchFrequency * 1000
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
