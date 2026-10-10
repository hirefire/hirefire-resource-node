const { Client } = require("./client")
const Lease = require("./lease")
const Once = require("./once")
const Plan = require("./plan")
const Sampler = require("./sampler")
const Payload = require("./dispatcher/payload")
const FailureLog = require("./dispatcher/failure_log")
const safeLog = require("./log")
const { formatError, verbose } = safeLog
const { RQT } = require("./strategy")

class Dispatcher {
  static PAYLOAD_SIZE_LIMIT = 131072
  static DEFAULT_DISPATCH_FREQUENCY = 1
  static MAX_DISPATCH_FREQUENCY = 30
  static BACKOFF_DOUBLINGS = 5
  static JOIN_TIMEOUT = 5

  constructor(configuration) {
    this._configuration = configuration
    this._client = new Client(configuration)
    this._lease = new Lease(configuration)
    this._running = false
    this._stopping = false
    this._stoppingFlush = false
    this._generation = 0
    this._lastRqtSecond = null
    this._dispatchFrequency = Dispatcher.DEFAULT_DISPATCH_FREQUENCY
    this._nextDispatchAt = null
    this._pendingSampleTrace = null
    this._sleepers = new Set()
    this._dispatchLoopPromise = null
    this._jobLoopPromise = null
    this._retiredLoops = new Set()
    this._stopJoinTimeoutMs = Dispatcher.JOIN_TIMEOUT * 1000
    this._resetSessionState()
  }

  start() {
    if (this._stopping) return false
    if (this._healthyRunning()) return false

    let retiredJq = null
    try {
      if (this._running && !this._dispatchLoopAlive()) {
        this._running = false
        if (this._jobLoopAlive()) {
          retiredJq = this._jobLoopPromise
          this._jobLoopPromise = null
        }
      }

      if (!this._running) {
        this._resetDispatchStateForRestart()
        this._lease.demote()
      }

      this._generation += 1
      const generation = this._generation
      this._wakeSleepers()
      this._running = true

      this._dispatchLoopPromise = this._loop(generation, () =>
        this._dispatchTick(generation),
      )
      if (this._enterRace()) {
        this._jobLoopPromise = this._loop(generation, () =>
          this._jobQueueTick(generation),
        )
      } else {
        this._jobLoopPromise = null
      }

      if (retiredJq) {
        this._retireLoop(retiredJq)
      }

      this._logger().info("[HireFire] Starting dispatcher.")
      return true
    } catch (error) {
      this._logger().error(
        `[HireFire] Could not start dispatcher: ${formatError(error)}`,
      )
      this._running = false
      return false
    }
  }

  ensureJobQueueLoop() {
    try {
      if (this._jobLoopAlive() && this._running && !this._stopping) {
        return
      }
      if (!this._enterRace()) return
      if (this._stopping) return
      if (!this._running) return
      if (this._jobLoopAlive()) return
      if (!this._enterRace()) return

      const generation = this._generation
      this._jobLoopPromise = this._loop(generation, () =>
        this._jobQueueTick(generation),
      )
    } catch (error) {
      this._logger().error(
        `[HireFire] Could not start job-queue loop: ${formatError(error)}`,
      )
    }
  }

  async stop(options = {}) {
    const { flush = true } = options
    if (this._stopping) return false
    if (!this._running) {
      await this._closeTransports()
      return false
    }

    this._stopping = true
    this._stoppingFlush = flush
    this._running = false
    this._wakeSleepers()

    const dispatchPromise = this._dispatchLoopPromise
    const jobPromise = this._jobLoopPromise
    const retired = [...this._retiredLoops]
    this._dispatchLoopPromise = null
    this._jobLoopPromise = null
    this._retiredLoops.clear()

    try {
      await this._joinLoops(dispatchPromise)
      await this._joinLoops(jobPromise)
      for (const loopPromise of retired) {
        await this._joinLoops(loopPromise)
      }

      if (flush) {
        await this._dispatch()
      } else {
        this._buffer().discardInherited()
      }

      this._logger().info("[HireFire] Dispatcher stopped.")
      return true
    } finally {
      await this._closeTransports()
      this._stopping = false
      this._stoppingFlush = false
    }
  }

  async _closeTransports() {
    try {
      await this._client.close()
    } catch (error) {
      this._logger().error(
        `[HireFire] Client close error: ${formatError(error)}`,
      )
    }
    try {
      this._lease.demote()
      await this._lease.close()
    } catch (error) {
      this._logger().error(
        `[HireFire] Lease close error: ${formatError(error)}`,
      )
    }
  }

  running() {
    return this._healthyRunning()
  }

  _healthyRunning() {
    return this._running && !this._stopping && this._dispatchLoopAlive()
  }

  _dispatchLoopAlive() {
    return this._loopPromiseAlive(this._dispatchLoopPromise)
  }

  _jobLoopAlive() {
    return this._loopPromiseAlive(this._jobLoopPromise)
  }

  _loopPromiseAlive(promise) {
    if (!promise) return false
    return promise._hirefireAlive !== false
  }

  _loopActive(generation) {
    return this._running && !this._stopping && this._generation === generation
  }

  _loop(generation, tick) {
    const promise = this._runLoop(generation, tick)
      .catch((error) => {
        this._logger().error(
          `[HireFire] Dispatcher loop stopped unexpectedly: ${formatError(
            error,
          )}`,
        )
      })
      .finally(() => {
        promise._hirefireAlive = false
      })
    promise._hirefireAlive = true
    return promise
  }

  _joinLoops(loopPromise) {
    if (!loopPromise) return Promise.resolve()
    let timer
    return Promise.race([
      Promise.resolve(loopPromise).finally(() => {
        if (timer != null) clearTimeout(timer)
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          this._logger().warn(
            `[HireFire] Dispatcher loop did not stop within ${Dispatcher.JOIN_TIMEOUT}s. Abandoning loop.`,
          )
          resolve()
        }, this._stopJoinTimeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
  }

  _retireLoop(loopPromise) {
    if (!loopPromise) return
    this._retiredLoops.add(loopPromise)
    void this._joinLoops(loopPromise).finally(() => {
      this._retiredLoops.delete(loopPromise)
    })
  }

  async _runLoop(generation, tick) {
    while (this._loopActive(generation)) {
      await tick()
      if (!this._loopActive(generation)) break
      await this._sleep(1000)
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

  async _dispatchTick(generation) {
    if (generation != null && !this._loopActive(generation)) return

    let sources = []
    await this._guard(() => {
      sources = this._configuration.activeCpuSources()
    })
    for (const source of sources) {
      await this._guard(() => source.sample())
    }
    await this._dispatchIfDue(generation)
  }

  _loopLive(generation) {
    if (generation != null) return () => this._loopActive(generation)
    return () => true
  }

  async _jobQueueTick(generation) {
    const live = this._loopLive(generation)
    if (!live()) return

    try {
      const hold = (plan) => this._sampler.canSample(plan)
      if (await this._lease.requestIfDue({ hold })) {
        this._leaseFailures.recovered()
      }
    } catch (error) {
      this._leaseFailures.failed(error)
    }
    if (!live()) return

    await this._guard(() =>
      this._lease.sampleIfDue(() => this._sampleJobQueues(live)),
    )
  }

  _resetDispatchStateForRestart() {
    this._nextDispatchAt = null
    this._lastRqtSecond = null
    this._dispatchFrequency = Dispatcher.DEFAULT_DISPATCH_FREQUENCY
    this._pendingSampleTrace = null
    this._resetSessionState()
  }

  _resetSessionState() {
    const configuration = this._configuration
    this._once = new Once(configuration)
    this._sampler = new Sampler(configuration)
    this._dispatchFailures = new FailureLog("Dispatch", configuration)
    this._leaseFailures = new FailureLog("Lease request", configuration)
    this._payloadDrops = new FailureLog("Metrics payload", configuration)
  }

  _enterRace() {
    return this._configuration.jobQueues.any() || Plan.anyLibraryLoaded()
  }

  async _sampleJobQueues(live = () => true) {
    this._pendingSampleTrace = await this._sampler.round(
      this._lease.jobQueues,
      live,
    )
  }

  async _dispatchIfDue(generation) {
    if (
      this._nextDispatchAt !== null &&
      performance.now() < this._nextDispatchAt
    ) {
      return
    }
    if (generation != null && !this._loopActive(generation)) return

    await this._dispatch(generation)
    if (generation == null || this._loopActive(generation)) {
      this._nextDispatchAt = performance.now() + this._dispatchInterval() * 1000
    }
  }

  _dispatchInterval() {
    const doublings = Math.min(
      this._dispatchFailures.count,
      Dispatcher.BACKOFF_DOUBLINGS,
    )
    return Math.min(
      this._dispatchFrequency * 2 ** doublings,
      Dispatcher.MAX_DISPATCH_FREQUENCY,
    )
  }

  async _guard(fn) {
    try {
      await fn()
    } catch (error) {
      this._logger().error(`[HireFire] ${formatError(error)}`)
    }
  }

  async _dispatch(generation) {
    if (generation != null && !this._loopActive(generation)) return

    let data
    try {
      data = this._buffer().flush()
      const { entries, watermark } = this._buildPayload(data)
      if (entries.length === 0) return

      let payload = entries
      let body = JSON.stringify(payload)
      if (
        Buffer.byteLength(body) > Dispatcher.PAYLOAD_SIZE_LIMIT &&
        Payload.traced(payload)
      ) {
        this._pendingSampleTrace = null
        payload = Payload.withoutTrace(payload)
        body = JSON.stringify(payload)
      }
      if (Buffer.byteLength(body) > Dispatcher.PAYLOAD_SIZE_LIMIT) {
        if (
          generation == null ||
          this._loopActive(generation) ||
          this._handoffToFinalFlush()
        ) {
          return this._dropOversizedPayload(body, watermark)
        }
        return
      }

      if (generation != null && !this._loopActive(generation)) {
        if (this._handoffToFinalFlush()) this._repopulateRqt(data)
        return
      }

      if (verbose()) {
        this._logger().info(`[HireFire] Dispatching metrics: ${body}`)
      }

      const response = await this._client.submitSamples(body)

      if (generation != null && !this._loopActive(generation)) {
        return
      }

      this._applyDispatchFrequency(response)
      if (response.tooLarge) {
        this._dropOversizedPayload(body, watermark, true)
      } else {
        if (watermark !== null) this._lastRqtSecond = watermark
        this._pendingSampleTrace = null
        this._payloadDrops.recovered()
      }
      this._dispatchFailures.recovered()
    } catch (error) {
      if (
        data &&
        (generation == null ||
          this._loopActive(generation) ||
          this._handoffToFinalFlush())
      ) {
        this._repopulateRqt(data)
      }
      this._dispatchFailures.failed(error)
    }
  }

  _handoffToFinalFlush() {
    return this._stopping && this._stoppingFlush
  }

  _repopulateRqt(data) {
    for (const [name, strategies] of Object.entries(data)) {
      const series = strategies && strategies[RQT]
      if (series && Object.keys(series).length > 0) {
        this._buffer().repopulate(name, RQT, series)
      }
    }
  }

  _applyDispatchFrequency(response) {
    const value = response.integer("HireFire-Dispatch-Frequency")
    if (value === null) return

    this._dispatchFrequency = Math.max(
      Dispatcher.DEFAULT_DISPATCH_FREQUENCY,
      Math.min(value, Dispatcher.MAX_DISPATCH_FREQUENCY),
    )
  }

  _dropOversizedPayload(body, watermark, server = false) {
    this._pendingSampleTrace = null
    if (watermark !== null) this._lastRqtSecond = watermark
    const source = server
      ? "server rejected (413)"
      : `exceeds the ${Dispatcher.PAYLOAD_SIZE_LIMIT}-byte limit`
    this._payloadDrops.record(
      `Dropped metrics payload: ${Buffer.byteLength(body)} bytes ${source}. ` +
        "Resuming from the current second.",
    )
  }

  _buildPayload(data) {
    const liveness = this._configuration.rqtEnabled
      ? this._configuration.httpName
      : null
    const trace = this._lease.trace() ? this._pendingSampleTrace : null

    return Payload.build(
      data,
      { liveness, since: this._lastRqtSecond, trace },
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

  _logger() {
    const logger = this._configuration.logger
    return {
      info: (message) => safeLog(logger, "info", message),
      warn: (message) => safeLog(logger, "warn", message),
      error: (message) => safeLog(logger, "error", message),
    }
  }
}

module.exports = Dispatcher
