const { Client } = require("./client")
const Lease = require("./lease")
const Once = require("./once")
const Plan = require("./plan")
const Probe = require("./probe")
const Payload = require("./dispatcher/payload")
const safeLog = require("./log")
const { formatError } = safeLog
const { RQT } = require("./strategy")

class Dispatcher {
  static PAYLOAD_SIZE_LIMIT = 131072
  static DEFAULT_DISPATCH_FREQUENCY = 1
  static MAX_DISPATCH_FREQUENCY = 30
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
    this._once = new Once(configuration)
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

    await this._guard(() =>
      this._lease.requestIfDue({ hold: (plan) => this._holdLease(plan) }),
    )
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
    this._once = new Once(this._configuration)
  }

  _enterRace() {
    return (
      this._configuration.jobQueues.any() ||
      Plan.anyAllowlistedJobQueueLibraryLoaded()
    )
  }

  _holdLease(planJobQueues) {
    if (this._configuration.jobQueues.any()) return true

    return planJobQueues.some((entry) => {
      return this._adapterPresent(entry) && Plan.sampleableEntry(entry)
    })
  }

  async _sampleJobQueues(live) {
    const probe = Probe.start()
    await Plan.aroundJobQueueSample(async () => {
      const localJobQueues = this._configuration.jobQueues

      for (const entry of this._lease.jobQueues) {
        if (live && !live()) break
        await probe.measure(entry, async () => {
          if (live && !live()) return
          if (this._adapterPresent(entry)) {
            await this._samplePlanAdapter(entry, localJobQueues, live)
          } else {
            await this._sampleStrategyOnly(entry, localJobQueues, live)
          }
        })
      }
    }, this._configuration)
    const payload = probe.finish()
    if (this._verbose()) probe.logTo(this._logger())
    if (this._lease.trace()) this._pendingSampleTrace = payload
  }

  _verbose() {
    const value = process.env.HIREFIRE_VERBOSE
    if (value == null || value === "") return false
    const lower = String(value).toLowerCase()
    return lower !== "0" && lower !== "false" && lower !== "no"
  }

  async _samplePlanAdapter(entry, localJobQueues, live) {
    if (live && !live()) return

    const name = String(entry.name ?? "")
    const adapter = entry.adapter
    const strategy = entry.strategy

    if (Plan.executable(adapter)) {
      if (!Plan.supportsStrategy(adapter, strategy)) {
        this._warnUnsupportedStrategyOnce(name, adapter, strategy)
        return
      }

      if (Plan.queuesRequired(adapter) && !Plan.namedPlanQueues(entry.queues)) {
        this._warnEmptyQueuesOnce(name, adapter)
        return
      }

      if (localJobQueues.findByName(name)) {
        this._warnPlanOverrideOnce(name)
      }
      if (live && !live()) return
      await Plan.execute(entry, this._configuration, live)
    } else if (Plan.knownAdapter(adapter)) {
      this._warnUnloadedAdapterOnce(name, adapter)
    } else {
      this._warnUnknownAdapterOnce(name, adapter)
    }
  }

  async _sampleStrategyOnly(entry, localJobQueues, live) {
    if (live && !live()) return

    const name = String(entry.name ?? "")
    const strategy = String(entry.strategy ?? "")

    if (!Plan.knownStrategy(strategy)) {
      this._warnUnknownStrategyOnce(name, strategy)
      return
    }

    const jobQueue = localJobQueues.findByName(name)
    if (jobQueue) {
      await localJobQueues.sampleJobQueue(jobQueue, strategy, {
        live,
        name: name.trim(),
      })
    }
  }

  _warnUnloadedAdapterOnce(name, adapter) {
    this._once.log(
      "error",
      "unloaded_adapter",
      name,
      `[HireFire] Plan adapter ${JSON.stringify(adapter)} for ${JSON.stringify(
        name,
      )} ` + `is not loaded in this process. Entry skipped.`,
    )
  }

  _warnPlanOverrideOnce(name) {
    this._once.log(
      "warn",
      "plan_override",
      name,
      `[HireFire] A HireFire UI adapter is configured for ` +
        `${JSON.stringify(name)}, so config.dyno(${JSON.stringify(
          name,
        )}) with a local sampler is ignored. ` +
        `You can remove that local configuration. The UI adapter is used instead.`,
    )
  }

  _warnUnknownAdapterOnce(name, adapter) {
    this._once.log(
      "error",
      "unknown_adapter",
      name,
      `[HireFire] Unknown plan adapter ` +
        `${JSON.stringify(adapter)} for ${JSON.stringify(
          name,
        )}. Entry skipped.`,
    )
  }

  _warnUnsupportedStrategyOnce(name, adapter, strategy) {
    this._once.log(
      "error",
      "unsupported_strategy",
      `${name}\0${adapter}\0${strategy}`,
      `[HireFire] Plan adapter ${JSON.stringify(adapter)} does not support ` +
        `strategy ${JSON.stringify(strategy)} for ${JSON.stringify(
          name,
        )}. Entry skipped.`,
    )
  }

  _warnUnknownStrategyOnce(name, strategy) {
    this._once.log(
      "error",
      "unknown_strategy",
      `${name}\0${strategy}`,
      `[HireFire] Unknown plan strategy ${JSON.stringify(strategy)} for ` +
        `${JSON.stringify(name)}. Entry skipped.`,
    )
  }

  _warnEmptyQueuesOnce(name, adapter) {
    this._once.log(
      "error",
      "queues_required",
      `${name}\0${adapter}`,
      `[HireFire] Plan adapter ${JSON.stringify(adapter)} for ` +
        `${JSON.stringify(name)} requires named queues. Entry skipped.`,
    )
  }

  _adapterPresent(entry) {
    const adapter = entry.adapter
    return !(adapter == null || adapter === "")
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
      this._nextDispatchAt = performance.now() + this._dispatchFrequency * 1000
    }
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

      if (this._verbose()) {
        this._logger().info(`[HireFire] Dispatching metrics: ${body}`)
      }

      const response = await this._client.submitSamples(body)

      if (generation != null && !this._loopActive(generation)) {
        return
      }

      this._applyDispatchFrequency(response)
      if (response.tooLarge) {
        return this._dropOversizedPayload(body, watermark, true)
      }
      if (watermark !== null) this._lastRqtSecond = watermark
      this._pendingSampleTrace = null
    } catch (error) {
      if (
        data &&
        (generation == null ||
          this._loopActive(generation) ||
          this._handoffToFinalFlush())
      ) {
        this._repopulateRqt(data)
      }
      this._logger().error(`[HireFire] Dispatch error: ${formatError(error)}`)
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
    this._logger().error(
      `[HireFire] Dropped metrics payload: ${Buffer.byteLength(
        body,
      )} bytes ${source}. ` + `Resuming from the current second.`,
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
