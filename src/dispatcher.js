const { Client } = require("./client")
const Lease = require("./lease")
const Workers = require("./workers")
const safeLog = require("./log")

class Dispatcher {
  // How far back (seconds) a dispatch may claim unreported web seconds. Matches
  // the server's ingest staleness acceptance and doubles as an honesty cap: a
  // process suspended longer than this must not assert liveness for that time.
  static WEB_BACKFILL_LIMIT = 60

  // Mirrors the server's request body cap; larger payloads are rejected with 413.
  static PAYLOAD_SIZE_LIMIT = 65536

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
    this._sleepTimer = null
    this._sleepResolve = null
    this._loopPromise = null
  }

  // Idempotent: a second call while running is a no-op. Unlike the Ruby
  // reference there is no fork/PID guard — Node's cluster.fork() re-execs into a
  // fresh process (new event loop, new singleton), so a running loop is never
  // inherited; each process lazily starts its own from configure() or the first
  // web request.
  start() {
    // Also refuse mid-stop: stop() clears _running before its awaits, so a
    // start() in that window would orphan a second loop.
    if (this._running || this._stopping) return false

    this._running = true
    // Backstop: anything escaping the guarded loop is logged and stops the
    // dispatcher rather than becoming an unhandled rejection (a crash on Node >=15).
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
    this._wakeSleep() // resolve any pending sleep so the loop exits promptly

    // Clear the handle before awaiting so a concurrent start() can't be orphaned.
    const loopPromise = this._loopPromise
    this._loopPromise = null
    await loopPromise // wait for the in-flight tick to finish (Ruby's join)

    await this._guard(() => this._dispatch()) // final flush, never rejecting

    this._stopping = false
    this._logger().info("[HireFire] Dispatcher stopped.")
    return true
  }

  running() {
    return this._running
  }

  // tick, then wait a second, then tick again — sequential, never overlapping,
  // mirroring the Ruby `while running?; tick; sleep 1; end` loop. The sleep
  // timer is unref'd so HireFire never keeps an otherwise-idle process alive.
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

  // Each stage is isolated: a failure in one (a lease renewal timing out, a job
  // sampler raising) must not starve the stages after it — most importantly
  // dispatch, which drains the buffer.
  async _tick() {
    await this._guard(() => this._lease.requestIfDue())
    await this._guard(() =>
      this._lease.sampleIfDue(() => this._workers.sample()),
    )
    for (const collector of this._cpu) {
      await this._guard(() => collector.sample())
    }
    await this._dispatch()
  }

  async _guard(fn) {
    try {
      await fn()
    } catch (error) {
      // error?.message ?? error so a non-Error throw (throw null, a rejected
      // string) can't make the guard itself throw and escape the loop.
      this._logger().error(`[HireFire] ${error?.message ?? error}`)
    }
  }

  async _dispatch() {
    // flush is inside the try so a dispatch can never reject and escape the loop.
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

      await this._client.submitSamples(body)
      // Advance only after a successful submit so the next success re-claims the
      // seconds whose delivery failed; duplicate empty claims are harmless
      // server-side.
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

  // Repopulating would retry the same oversized payload every tick, so it is
  // dropped outright. Advancing the watermark leaves the dropped seconds
  // unclaimed (missing data) rather than backfilled as empty (zero traffic).
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
      // Identity says this is not the http-serving process: real samples are
      // still delivered, but no liveness is synthesized — this process must not
      // claim the web name's seconds.
      entries.push({ name: this._web.name, samples: data.web })
    }

    entries.push(...data.workers)

    for (const [name, samples] of Object.entries(data.cpu)) {
      entries.push({ name, samples })
    }

    return entries
  }

  // Claims every second since the last successfully dispatched one: seconds with
  // buffered samples keep them, seconds without get an explicit empty claim,
  // which the server reads as 0 traffic — so a delivery blip never leaves a gap
  // that an additive metric would misread as missing data. With no watermark
  // (first dispatch after boot) only the current second is claimed: a fresh
  // process must not assert liveness for time before it existed.
  _backfillWebSeconds(samples) {
    const now = Math.floor(Date.now() / 1000)
    let from = this._lastWebSecond !== null ? this._lastWebSecond + 1 : now
    if (from < now - Dispatcher.WEB_BACKFILL_LIMIT)
      from = now - Dispatcher.WEB_BACKFILL_LIMIT
    if (from > now) from = now

    const result = { ...samples } // keep synthesized claims out of the retry buffer
    for (let second = from; second <= now; second++) {
      if (result[second] === undefined) result[second] = []
    }
    return result
  }

  _buffer() {
    return this._configuration.buffer
  }

  // Wraps the user-supplied logger so a missing method or a throw inside it can
  // never crash the dispatch loop or its terminal crash backstop.
  _logger() {
    const logger = this._configuration.logger
    return {
      info: (message) => safeLog(logger, "info", message),
      error: (message) => safeLog(logger, "error", message),
    }
  }
}

module.exports = Dispatcher
