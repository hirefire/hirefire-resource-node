const { Client } = require("./client")
const Lease = require("./lease")
const Workers = require("./workers")
const safeLog = require("./log")

/**
 * Periodic reporter that samples workers/CPU and flushes buffered metrics to the API.
 */
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
    this._generation = 0
    this._lastWebSecond = null
    this._interval = 1
    this._dispatchFrequency = Dispatcher.DEFAULT_DISPATCH_FREQUENCY
    this._nextDispatchAt = null
    this._sleepers = new Set()
    this._loopPromise = null
    this._stopJoinTimeoutMs = 5000
  }

  /**
   * Starts the dispatcher loops.
   *
   * @returns {boolean} `true` when started, `false` if already running or stopping.
   */
  start() {
    if (this._running || this._stopping) return false

    this._generation += 1
    const generation = this._generation
    this._running = true

    const loops = [this._loop(generation, () => this._dispatchTick())]
    if (this._workers.any()) {
      loops.push(this._loop(generation, () => this._workerTick()))
    }
    this._loopPromise = Promise.all(loops)

    this._logger().info("[HireFire] Starting dispatcher.")
    return true
  }

  /**
   * Stops the dispatcher loops and closes transport resources.
   *
   * Joins local loop tasks for up to 5 seconds each, then performs a best-effort final flush
   * before closing the HTTP client and lease connection. Loop generations prevent a hung loop
   * that outlives the join from resuming work after a later {@link Dispatcher#start}.
   *
   * @returns {Promise<boolean>} Resolves to `true` once the dispatcher has stopped. Resolves to
   *   `false` when the dispatcher was not running.
   */
  async stop() {
    if (!this._running) return false

    this._running = false
    this._stopping = true
    this._wakeSleepers()

    const loopPromise = this._loopPromise
    this._loopPromise = null
    await this._joinLoops(loopPromise)

    await this._guard(() => this._dispatch())

    this._client.close()
    this._lease.close()

    this._stopping = false
    this._logger().info("[HireFire] Dispatcher stopped.")
    return true
  }

  /**
   * Whether the dispatcher is currently running.
   *
   * @returns {boolean}
   */
  running() {
    return this._running
  }

  _loopActive(generation) {
    return this._running && this._generation === generation
  }

  _loop(generation, tick) {
    return this._runLoop(generation, tick).catch((error) => {
      this._logger().error(
        `[HireFire] Dispatcher loop stopped unexpectedly: ${
          error?.message ?? error
        }`,
      )
    })
  }

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

  async _runLoop(generation, tick) {
    while (this._loopActive(generation)) {
      await tick()
      if (!this._loopActive(generation)) break
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
      const { entries, watermark } = this._buildPayload(data)
      if (entries.length === 0) return

      const body = JSON.stringify(entries)
      if (Buffer.byteLength(body) > Dispatcher.PAYLOAD_SIZE_LIMIT) {
        return this._dropOversizedPayload(body, watermark)
      }

      if (process.env.HIREFIRE_VERBOSE) {
        this._logger().info(`[HireFire] Dispatching metrics: ${body}`)
      }

      const response = await this._client.submitSamples(body)
      this._applyDispatchFrequency(response)
      if (watermark !== undefined) this._lastWebSecond = watermark
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

  _dropOversizedPayload(body, watermark) {
    if (watermark !== undefined) this._lastWebSecond = watermark
    this._logger().error(
      `[HireFire] Dropped metrics payload: ${Buffer.byteLength(
        body,
      )} bytes exceeds ` +
        `the ${Dispatcher.PAYLOAD_SIZE_LIMIT}-byte limit. Resuming from the current second.`,
    )
  }

  _buildPayload(data) {
    const entries = []
    let watermark

    if (this._web && this._webLiveness) {
      const samples = this._backfillWebSeconds(data.web)
      watermark = Math.max(...Object.keys(samples).map(Number))
      entries.push({ name: this._web.name, samples })
    } else if (this._web && Object.keys(data.web).length > 0) {
      entries.push({ name: this._web.name, samples: data.web })
    }

    entries.push(...data.workers)

    for (const [name, samples] of Object.entries(data.cpu)) {
      entries.push({ name, samples })
    }

    return { entries, watermark }
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
