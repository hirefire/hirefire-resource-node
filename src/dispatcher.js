const { Client } = require("./client")
const Lease = require("./lease")
const MetricsBuffer = require("./buffer")
const Plan = require("./plan")
const safeLog = require("./log")
const { rqtParts } = MetricsBuffer

/**
 * Periodic reporter that samples job queues and CPU and flushes buffered metrics to the API.
 */
class Dispatcher {
  static RQT_BACKFILL_LIMIT = 60

  static PAYLOAD_SIZE_LIMIT = 32768
  static SAMPLE_COUNT_LIMIT = MetricsBuffer.SAMPLE_COUNT_LIMIT
  static METRIC_VALUE_LIMIT = 1e15

  static DEFAULT_DISPATCH_FREQUENCY = 1
  static MAX_DISPATCH_FREQUENCY = 30
  static JOIN_TIMEOUT = 5

  /**
   * @param {import("./configuration")} configuration
   */
  constructor(configuration) {
    this._configuration = configuration
    this._client = new Client(configuration)
    this._lease = new Lease(configuration)
    this._running = false
    this._stopping = false
    this._stoppingFlush = false
    this._generation = 0
    this._lastRqtSecond = null
    this._interval = 1
    this._dispatchFrequency = Dispatcher.DEFAULT_DISPATCH_FREQUENCY
    this._nextDispatchAt = null
    this._sleepers = new Set()
    this._dispatchLoopPromise = null
    this._jobLoopPromise = null
    /** @type {Set<Promise<unknown>>} */
    this._retiredLoops = new Set()
    this._stopJoinTimeoutMs = Dispatcher.JOIN_TIMEOUT * 1000
    this._unloadedAdapterWarned = Object.create(null)
    this._planOverrideWarned = Object.create(null)
    this._unknownAdapterWarned = Object.create(null)
    this._unsupportedStrategyWarned = Object.create(null)
    this._unknownStrategyWarned = Object.create(null)
  }

  /**
   * Starts the dispatcher loops.
   *
   * @returns {boolean} `true` when started, `false` if already healthy or stopping.
   */
  start() {
    if (this._stopping) return false
    if (this._healthyRunning()) return false

    let retiredJq = null
    try {
      // Latched _running with a dead main loop: clear and retire a still-live
      // job loop before spawning a new generation (Ruby joins retired_jq ≤5s).
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
      // Wake sleepers so a retired same-process job loop exits promptly.
      this._wakeSleepers()
      this._running = true

      this._dispatchLoopPromise = this._loop(generation, () =>
        this._dispatchTick(generation),
      )
      if (this._enterRace()) {
        this._jobLoopPromise = this._loop(generation, () =>
          this._workerTick(generation),
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
        `[HireFire] Could not start dispatcher: ${error?.message ?? error}`,
      )
      this._running = false
      return false
    }
  }

  /**
   * Ensures the job-queue loop is running when lease race entry becomes true after a late configure.
   *
   * @returns {void}
   */
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
        this._workerTick(generation),
      )
    } catch (error) {
      this._logger().error(
        `[HireFire] Could not start job-queue loop: ${error?.message ?? error}`,
      )
    }
  }

  /**
   * Stops the dispatcher loops and closes transport resources.
   *
   * @param {{flush?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async stop({ flush = true } = {}) {
    if (!this._running) return false
    if (this._stopping) return false

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
      try {
        await this._client.close()
      } catch (error) {
        this._logger().error(
          `[HireFire] Client close error: ${error?.message ?? error}`,
        )
      }
      try {
        this._lease.demote()
        await this._lease.close()
      } catch (error) {
        this._logger().error(
          `[HireFire] Lease close error: ${error?.message ?? error}`,
        )
      }
      this._stopping = false
      this._stoppingFlush = false
    }
  }

  /**
   * @returns {boolean}
   */
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
    // Track settled state via flag attached when the loop ends.
    return promise._hirefireAlive !== false
  }

  _loopActive(generation) {
    return this._running && !this._stopping && this._generation === generation
  }

  _loop(generation, tick) {
    const promise = this._runLoop(generation, tick)
      .catch((error) => {
        this._logger().error(
          `[HireFire] Dispatcher loop stopped unexpectedly: ${
            error?.message ?? error
          }`,
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
      // Clear the abandon timer when the loop settles first. Otherwise the
      // timeout callback still runs ~JOIN_TIMEOUT later and falsely warns.
      Promise.resolve(loopPromise).finally(() => {
        if (timer != null) clearTimeout(timer)
      }),
      new Promise((resolve) => {
        timer = setTimeout(() => {
          this._logger().warn(
            `[HireFire] Dispatcher loop did not stop within ${Dispatcher.JOIN_TIMEOUT}s. Abandoning thread.`,
          )
          resolve()
        }, this._stopJoinTimeoutMs)
        if (timer.unref) timer.unref()
      }),
    ])
  }

  /**
   * Track a retired loop for stop() joins and join it with the usual bound.
   * @param {Promise<unknown>} loopPromise
   */
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

  async _dispatchTick(generation) {
    if (generation != null && !this._loopActive(generation)) return

    for (const collector of this._configuration.activeCpuSources()) {
      await this._guard(() => collector.sample())
    }
    await this._dispatchIfDue(generation)
  }

  async _workerTick(generation) {
    if (generation != null && !this._loopActive(generation)) return

    await this._guard(() =>
      this._lease.requestIfDue({ hold: (plan) => this._holdLease(plan) }),
    )
    if (generation != null && !this._loopActive(generation)) return

    await this._guard(() =>
      this._lease.sampleIfDue(() => this._sampleJobQueues()),
    )
  }

  _resetDispatchStateForRestart() {
    this._nextDispatchAt = null
    this._lastRqtSecond = null
    this._dispatchFrequency = Dispatcher.DEFAULT_DISPATCH_FREQUENCY
    this._unloadedAdapterWarned = Object.create(null)
    this._planOverrideWarned = Object.create(null)
    this._unknownAdapterWarned = Object.create(null)
    this._unsupportedStrategyWarned = Object.create(null)
    this._unknownStrategyWarned = Object.create(null)
  }

  _enterRace() {
    return (
      this._configuration.workers.any() ||
      Plan.anyAllowlistedJobQueueLibraryLoaded()
    )
  }

  _holdLease(planJobQueues) {
    if (this._configuration.workers.any()) return true

    return planJobQueues.some((entry) => {
      return (
        this._adapterPresent(entry) &&
        Plan.executable(entry.adapter) &&
        Plan.supportsStrategy(entry.adapter, entry.strategy)
      )
    })
  }

  async _sampleJobQueues() {
    await Plan.aroundJobQueueSample(async () => {
      const localWorkers = this._configuration.workers

      for (const entry of this._lease.jobQueues) {
        if (this._adapterPresent(entry)) {
          await this._samplePlanAdapter(entry, localWorkers)
        } else {
          await this._sampleStrategyOnly(entry, localWorkers)
        }
      }
    }, this._configuration)
  }

  async _samplePlanAdapter(entry, localWorkers) {
    const name = String(entry.name ?? "")
    const adapter = entry.adapter
    const strategy = entry.strategy

    if (Plan.executable(adapter)) {
      if (!Plan.supportsStrategy(adapter, strategy)) {
        this._warnUnsupportedStrategyOnce(name, adapter, strategy)
        return
      }

      if (localWorkers.findByName(name)) {
        this._warnPlanOverrideOnce(name)
      }
      await Plan.execute(entry, this._configuration)
    } else if (Plan.knownAdapter(adapter)) {
      this._warnUnloadedAdapterOnce(name, adapter)
    } else {
      this._warnUnknownAdapterOnce(name, adapter)
    }
  }

  async _sampleStrategyOnly(entry, localWorkers) {
    const name = String(entry.name ?? "")
    const strategy = String(entry.strategy ?? "")

    if (!Plan.knownStrategy(strategy)) {
      this._warnUnknownStrategyOnce(name, strategy)
      return
    }

    const worker = localWorkers.findByName(name)
    if (worker) {
      await localWorkers.sampleJobQueue(worker, strategy)
    }
  }

  _warnUnloadedAdapterOnce(name, adapter) {
    if (this._unloadedAdapterWarned[name]) return
    this._unloadedAdapterWarned[name] = true
    this._logger().error(
      `[HireFire] Plan adapter ${JSON.stringify(adapter)} for ${JSON.stringify(
        name,
      )} ` + `is not loaded in this process. Entry skipped.`,
    )
  }

  _warnPlanOverrideOnce(name) {
    if (this._planOverrideWarned[name]) return
    this._planOverrideWarned[name] = true
    this._logger().warn(
      `[HireFire] A HireFire UI adapter is configured for ` +
        `${JSON.stringify(name)}, so config.dyno(${JSON.stringify(
          name,
        )}) with a local sampler is ignored. ` +
        `You can remove that local configuration; the UI adapter is used instead.`,
    )
  }

  _warnUnknownAdapterOnce(name, adapter) {
    if (this._unknownAdapterWarned[name]) return
    this._unknownAdapterWarned[name] = true
    this._logger().error(
      `[HireFire] Unknown plan adapter ` +
        `${JSON.stringify(adapter)} for ${JSON.stringify(
          name,
        )}. Entry skipped.`,
    )
  }

  _warnUnsupportedStrategyOnce(name, adapter, strategy) {
    const key = `${name}\0${adapter}\0${strategy}`
    if (this._unsupportedStrategyWarned[key]) return
    this._unsupportedStrategyWarned[key] = true
    this._logger().error(
      `[HireFire] Plan adapter ${JSON.stringify(adapter)} does not support ` +
        `strategy ${JSON.stringify(strategy)} for ${JSON.stringify(
          name,
        )}. Entry skipped.`,
    )
  }

  _warnUnknownStrategyOnce(name, strategy) {
    const key = `${name}\0${strategy}`
    if (this._unknownStrategyWarned[key]) return
    this._unknownStrategyWarned[key] = true
    this._logger().error(
      `[HireFire] Unknown plan strategy ${JSON.stringify(strategy)} for ` +
        `${JSON.stringify(name)}. Entry skipped.`,
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
      this._logger().error(
        `[HireFire] ${error?.name ?? "Error"}: ${error?.message ?? error}`,
      )
    }
  }

  async _dispatch(generation) {
    if (generation != null && !this._loopActive(generation)) return

    let data
    try {
      data = this._buffer().flush()
      const { entries, watermark } = this._buildPayload(data)
      if (entries.length === 0) return

      const body = JSON.stringify(entries)
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

      if (process.env.HIREFIRE_VERBOSE) {
        this._logger().info(`[HireFire] Dispatching metrics: ${body}`)
      }

      const response = await this._client.submitSamples(body)

      if (generation != null && !this._loopActive(generation)) {
        return
      }

      if (response === "payload_too_large") {
        return this._dropOversizedPayload(body, watermark, true)
      }
      this._applyDispatchFrequency(response)
      if (watermark !== undefined) this._lastRqtSecond = watermark
    } catch (error) {
      if (
        data &&
        (generation == null ||
          this._loopActive(generation) ||
          this._handoffToFinalFlush())
      ) {
        this._repopulateRqt(data)
      }
      this._logger().error(
        `[HireFire] Dispatch error: ${error?.name ?? "Error"}: ${
          error?.message ?? error
        }`,
      )
    }
  }

  _handoffToFinalFlush() {
    return this._stopping && this._stoppingFlush
  }

  _repopulateRqt(data) {
    for (const [name, strategies] of Object.entries(data)) {
      const series = strategies && strategies.rqt
      if (series && Object.keys(series).length > 0) {
        this._buffer().repopulate(name, "rqt", series)
      }
    }
  }

  _applyDispatchFrequency(response) {
    if (!response || !response.headers) return

    const value = parseInt(response.headers["hirefire-dispatch-frequency"], 10)
    if (!Number.isFinite(value) || value <= 0) return

    this._dispatchFrequency = Math.max(
      Dispatcher.DEFAULT_DISPATCH_FREQUENCY,
      Math.min(value, Dispatcher.MAX_DISPATCH_FREQUENCY),
    )
  }

  _dropOversizedPayload(body, watermark, server = false) {
    if (watermark !== undefined) this._lastRqtSecond = watermark
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
    const entriesByName = Object.create(null)
    const httpName = this._configuration.httpName
    const watermark = this._appendHttpRqt(entriesByName, data, httpName)

    for (const [name, strategies] of Object.entries(data)) {
      for (const [strategy, series] of Object.entries(strategies || {})) {
        if (!series || Object.keys(series).length === 0) continue
        if (strategy === "rqt" && name === httpName) continue
        this._mergeMetrics(entriesByName, name, strategy, series)
      }
    }

    const entries = []
    for (const [name, metrics] of Object.entries(entriesByName)) {
      const encoded = Object.create(null)
      for (const [strategy, series] of Object.entries(metrics)) {
        const leafSeries = Object.create(null)
        for (const [second, bucket] of Object.entries(series)) {
          const leaf = this._encodeLeaf(strategy, bucket)
          if (leaf === undefined) continue
          leafSeries[String(second)] = leaf
        }
        if (Object.keys(leafSeries).length > 0) encoded[strategy] = leafSeries
      }
      if (Object.keys(encoded).length > 0) {
        entries.push({ name, metrics: encoded })
      }
    }

    return { entries, watermark }
  }

  _appendHttpRqt(entriesByName, data, httpName) {
    if (!httpName) return undefined

    const rqtBuckets = (data[httpName] && data[httpName].rqt) || {}
    if (this._configuration.rqtEnabled && this._configuration.rqtLiveness) {
      const payloadRqt = this._backfillRqtSeconds(rqtBuckets)
      this._mergeMetrics(entriesByName, httpName, "rqt", payloadRqt)
      const keys = Object.keys(payloadRqt).map(Number)
      if (keys.length > 0) return Math.max(...keys)
      return undefined
    }
    if (Object.keys(rqtBuckets).length > 0) {
      this._mergeMetrics(entriesByName, httpName, "rqt", rqtBuckets)
    }
    return undefined
  }

  _mergeMetrics(entriesByName, name, strategy, seriesBuckets) {
    if (!entriesByName[name]) entriesByName[name] = Object.create(null)
    if (!entriesByName[name][strategy])
      entriesByName[name][strategy] = Object.create(null)
    const dest = entriesByName[name][strategy]

    for (const [secondKey, bucket] of Object.entries(seriesBuckets)) {
      const second = parseInt(secondKey, 10)
      if (strategy === "rqt") {
        const { sum, count } = rqtParts(bucket)
        const existing = dest[second]
        if (!existing) {
          dest[second] = { sum, count }
        } else {
          dest[second] = {
            sum: existing.sum + sum,
            count: existing.count + count,
          }
        }
      } else {
        dest[second] = bucket
      }
    }
  }

  _encodeLeaf(strategy, bucket) {
    if (strategy === "rqt") {
      // Reject non-finite sum/count before rqtParts (which zeros them for merge).
      if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
        const sumRaw = Number(bucket.sum)
        const countRaw = Number(bucket.count)
        if (!Number.isFinite(sumRaw) || !Number.isFinite(countRaw)) {
          this._logger().error(
            "[HireFire] Omitting rqt second: non-finite or out-of-range mean.",
          )
          return undefined
        }
      }
      const { sum, count } = rqtParts(bucket)
      if (count === 0) return []
      const mean = sum / count
      if (
        !Number.isFinite(mean) ||
        mean < 0 ||
        mean > Dispatcher.METRIC_VALUE_LIMIT
      ) {
        this._logger().error(
          "[HireFire] Omitting rqt second: non-finite or out-of-range mean.",
        )
        return undefined
      }
      const n =
        count > Dispatcher.SAMPLE_COUNT_LIMIT
          ? Dispatcher.SAMPLE_COUNT_LIMIT
          : Math.trunc(count)
      return [mean, n]
    }
    if (typeof bucket !== "number" || !Number.isFinite(bucket)) {
      this._logger().error(
        `[HireFire] Omitting ${strategy} second: non-finite or out-of-range value.`,
      )
      return undefined
    }
    if (bucket < 0 || bucket > Dispatcher.METRIC_VALUE_LIMIT) {
      this._logger().error(
        `[HireFire] Omitting ${strategy} second: non-finite or out-of-range value.`,
      )
      return undefined
    }
    return bucket
  }

  _backfillRqtSeconds(buckets) {
    const now = Math.floor(Date.now() / 1000)
    let from = this._lastRqtSecond !== null ? this._lastRqtSecond + 1 : now
    if (from < now - Dispatcher.RQT_BACKFILL_LIMIT)
      from = now - Dispatcher.RQT_BACKFILL_LIMIT
    if (from > now) from = now

    const payload = Object.create(null)
    for (const [secondKey, bucket] of Object.entries(buckets)) {
      const { sum, count } = rqtParts(bucket)
      payload[parseInt(secondKey, 10)] = { sum, count }
    }
    for (let second = from; second <= now; second++) {
      if (payload[second] === undefined) payload[second] = { sum: 0, count: 0 }
    }
    return payload
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
