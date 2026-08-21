const HTTP = require("./source/http")
const JobQueue = require("./source/jobQueue")
const JobQueues = require("./source/jobQueues")
const CPU = require("./source/cpu")
const MetricsBuffer = require("./buffer")
const Dispatcher = require("./dispatcher")
const Identity = require("./identity")
const safeLog = require("./log")

/**
 * Duck-typed logger used for HireFire diagnostic messages. Methods are optional: callers may
 * implement only the levels they care about. `console` satisfies this type.
 *
 * @typedef {object} Logger
 * @property {(message: string) => void} [error]
 * @property {(message: string) => void} [warn]
 * @property {(message: string) => void} [info]
 */

/**
 * Thrown when {@link Configuration#dyno} cannot resolve a source because a name other than
 * `"web"` was given without a sampler. Bare `dyno("web")` is a backwards-compatible no-op.
 */
class MissingSamplerError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = "MissingSamplerError"
  }
}

/**
 * Thrown when a dyno name was already declared for the same source kind (names are compared
 * case-insensitively), or a second http process is declared in the same app process.
 */
class DuplicateDynoError extends Error {
  /**
   * @param {string} message
   */
  constructor(message) {
    super(message)
    this.name = "DuplicateDynoError"
  }
}

const MAX_NAME_BYTES = 128

/**
 * Holds process-wide settings (token, logger) and optional local declarations via {@link Configuration#dyno}.
 *
 * Always-on sources (request queue time on the HTTP middleware path, and CPU when process
 * identity resolves) do not require an explicit dyno declaration. Local job-queue sampler
 * functions remain the escape hatch for custom probes until lease plans cover them fully.
 */
class Configuration {
  constructor() {
    /**
     * Always `null`. Kept for readers that still check `configuration.http`. Request queue
     * time uses always-on sources under {@link Configuration#httpName} (process identity).
     * @type {import("./source/http") | null}
     */
    this.http = null
    /**
     * Local job-queue sources declared via sampler functions on {@link Configuration#dyno}.
     * @type {import("./source/jobQueues")}
     */
    this.jobQueues = new JobQueues(this)
    /**
     * Logger used for HireFire diagnostic messages. Defaults to `console`. Set to `null`
     * (or a logger missing the log methods) to silence diagnostics.
     * @type {Logger | null}
     */
    this.logger = console
    /**
     * @type {boolean}
     */
    this._logQueueMetrics = false
    this._logQueueMetricsWarned = false
    /**
     * @type {Map<string, string[]>}
     */
    this._sourcesByName = new Map()
    /**
     * @type {string | null}
     */
    this._token = null
    /**
     * @type {import("./buffer") | null}
     */
    this._buffer = null
    /**
     * @type {import("./dispatcher") | null}
     */
    this._dispatcher = null
    /**
     * @type {import("./source/cpu") | null}
     */
    this._alwaysOnCpu = null
    /**
     * @type {import("./source/http") | null}
     */
    this._alwaysOnHttp = null
    this._httpActive = false
    this._herokuConflictWarned = false
    this._cpuUnresolvedWarned = false
    this._rqtUnresolvedWarned = false
    this._identityNameTooLongWarned = false
    this._bareWebDynoWarned = false
  }

  /**
   * The HireFire API token. Returns the value assigned in code when it is not `null`/`undefined`,
   * else the `HIREFIRE_TOKEN` environment variable, else `null`. An empty string (in code or from
   * the env) is treated as absent (`null`), so it neither enables reporting nor is sent on the wire.
   * Assigning `null` (or `undefined`) clears the in-code value so the environment variable is
   * consulted again. Assigning an empty string forces the token off even when `HIREFIRE_TOKEN` is
   * set. A non-empty token present when {@link HireFire#configure} or {@link HireFire#boot} runs
   * starts the dispatcher and enables reporting.
   *
   * @type {string | null}
   */
  get token() {
    const value =
      this._token === null || this._token === undefined
        ? process.env.HIREFIRE_TOKEN
        : this._token
    if (value == null) return null
    const stripped = String(value).trim()
    return stripped.length > 0 ? stripped : null
  }

  /**
   * @param {string | null | undefined} value
   */
  set token(value) {
    this._token = value
  }

  /**
   * Legacy flag: when true, middleware still prints `[hirefire:router] queue=…ms`
   * to stdout (Logplex QueueTime BC). Setting true once-warns to migrate to HireFire
   * Request Queue Time with `HIREFIRE_TOKEN`. Preferred web RQT is push to
   * data.hirefire.io.
   *
   * @type {boolean}
   */
  get logQueueMetrics() {
    return this._logQueueMetrics
  }

  /**
   * @param {boolean} value
   */
  set logQueueMetrics(value) {
    this._logQueueMetrics = Boolean(value)
    if (this._logQueueMetrics) this._warnLogQueueMetricsOnce()
  }

  /**
   * Declares a process by dyno name (Heroku Procfile-shaped).
   *
   * A sampler function registers a local job-queue source (`jql` / `jqs` under the lease
   * plan strategy). Prefer zero-config for request queue time and CPU, and lease plan
   * adapters in the HireFire UI for managed job queues. Use {@link Configuration#dyno} with
   * a sampler for custom probes or strategy-only (custom configuration) plan entries.
   *
   * Bare `dyno("web")` (no sampler, name `"web"` case-insensitive) is accepted for 1.x
   * backwards compatibility but does nothing: RQT is armed only by platform web role and
   * middleware traffic. A once-per-process warning explains that the line can be removed.
   * `dyno("web", sampler)` still registers a job-queue sampler under `"web"`.
   *
   * @overload
   * @param {string} name - The process name. Bare `"web"` is a no-op with a once-warn.
   * @returns {void}
   * @throws {TypeError} The name is empty/whitespace-only, exceeds 128 bytes, more than two
   *   arguments, or a non-function second argument is given.
   * @throws {MissingSamplerError} A name other than `"web"` given without a sampler.
   * @throws {DuplicateDynoError} The name was already declared for the same source kind.
   * @example
   * config.dyno("web") // no-op BC; safe to remove
   * config.dyno("worker", () => jobQueueSize("default"))
   */
  /**
   * @overload
   * @param {string} name - The process name. Must be non-empty.
   * @param {() => number | Promise<number>} sampler - Returns the current job-queue metric (a
   *   non-negative, finite number).
   * @returns {void}
   */
  /**
   * @param {string} name
   * @param {(() => number | Promise<number>) | null | undefined} [sampler]
   * @returns {void}
   */
  dyno(name, sampler) {
    if (arguments.length > 2) {
      throw new TypeError(
        "config.dyno accepts at most two arguments (name, sampler).",
      )
    }
    if (sampler != null && typeof sampler !== "function") {
      throw new TypeError(
        `Invalid sampler ${inspect(
          sampler,
        )} for config.dyno. Pass a function for job-queue metrics.`,
      )
    }

    name = coerceName(name)

    if (typeof sampler === "function") {
      this._register(name, "job_queue", sampler)
      return
    }

    if (name.toLowerCase() === "web") {
      this._warnBareWebDynoOnce()
      return
    }

    throw new MissingSamplerError(
      `config.dyno("${name}") could not be resolved: it needs a sampler function ` +
        `(job-queue metrics). Request queue time is always-on via platform web role or ` +
        `middleware traffic; CPU is always-on when process identity resolves. ` +
        `Bare config.dyno("web") is a no-op and can be removed.`,
    )
  }

  /**
   * In-memory metric buffer that accumulates samples between dispatcher flushes.
   *
   * @returns {import("./buffer")}
   */
  get buffer() {
    if (!this._buffer) this._buffer = new MetricsBuffer()
    return this._buffer
  }

  /**
   * Periodic reporter that samples job queues and CPU and flushes buffered metrics to the API.
   *
   * @returns {import("./dispatcher")}
   */
  get dispatcher() {
    if (!this._dispatcher) {
      this._dispatcher = new Dispatcher(this)
    }
    return this._dispatcher
  }

  get httpName() {
    return this._softIdentity()
  }

  markHttpActive() {
    this._httpActive = true
  }

  get rqtEnabled() {
    return Boolean(this._httpActive || Identity.platformHttpRole())
  }

  get httpSource() {
    const name = this.httpName
    if (name == null) {
      if (this.token && (this._httpActive || Identity.platformHttpRole())) {
        this._warnRqtUnresolvedOnce()
      }
      return null
    }

    if (
      !this._alwaysOnHttp ||
      this._alwaysOnHttp.name.toLowerCase() !== name.toLowerCase()
    ) {
      this._alwaysOnHttp = new HTTP(name, this)
    }
    return this._alwaysOnHttp
  }

  get rqtLiveness() {
    if (!this.rqtEnabled) return false

    const identity = this._softIdentity()
    const httpName = this.httpName
    if (identity == null || httpName == null) return false

    return identity.toLowerCase() === httpName.toLowerCase()
  }

  activeCpuSources() {
    const identity = this._softIdentity()
    if (identity == null) {
      this._warnCpuUnresolvedOnce()
      return []
    }

    if (
      !this._alwaysOnCpu ||
      this._alwaysOnCpu.name.toLowerCase() !== identity.toLowerCase()
    ) {
      this._alwaysOnCpu = new CPU(identity, this)
    }
    return [this._alwaysOnCpu]
  }

  _register(name, source, sampler) {
    const key = name.toLowerCase()
    const kinds = this._sourcesByName.get(key) || []

    if (kinds.includes(source)) {
      throw new DuplicateDynoError(
        `Duplicate declaration for "${name}". ` +
          `Each dyno name maps to at most one source of each kind.`,
      )
    }

    if (source === "job_queue") {
      this.jobQueues.add(new JobQueue(this._canonicalName(name), sampler))
    }

    this._sourcesByName.set(key, kinds.concat(source))
  }

  _canonicalName(name) {
    for (const key of this._sourcesByName.keys()) {
      if (key.toLowerCase() === name.toLowerCase()) {
        const existing = [...this.jobQueues]
          .map((w) => w.name)
          .find((n) => n.toLowerCase() === name.toLowerCase())
        return existing || name
      }
    }
    return name
  }

  _softIdentity() {
    this._warnHerokuConflictOnce()
    const name = Identity.resolve()
    if (name == null) return null
    if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name
    this._warnIdentityNameTooLongOnce(name)
    return null
  }

  _warnIdentityNameTooLongOnce(name) {
    if (this._identityNameTooLongWarned) return
    this._identityNameTooLongWarned = true
    safeLog(
      this.logger,
      "error",
      `[HireFire] Process identity exceeds ${MAX_NAME_BYTES} bytes ` +
        `(${Buffer.byteLength(
          name,
        )}). Metrics under this identity are disabled until the name is shortened.`,
    )
  }

  _warnBareWebDynoOnce() {
    if (this._bareWebDynoWarned) return
    this._bareWebDynoWarned = true
    safeLog(
      this.logger,
      "warn",
      '[HireFire] config.dyno("web") without a sampler is no longer necessary. ' +
        "Request queue time is armed by platform web identity (for example DYNO type web " +
        "or RENDER_SERVICE_TYPE=web) and by HTTP middleware traffic. You can remove this line.",
    )
  }

  _warnLogQueueMetricsOnce() {
    if (this._logQueueMetricsWarned) return
    this._logQueueMetricsWarned = true
    safeLog(
      this.logger,
      "warn",
      "[HireFire] config.logQueueMetrics is deprecated. Prefer the HireFire Request " +
        "Queue Time strategy, set HIREFIRE_TOKEN, then remove this logQueueMetrics = " +
        "true line. Stdout [hirefire:router] lines still emit while this flag is set.",
    )
  }

  _warnRqtUnresolvedOnce() {
    if (this._rqtUnresolvedWarned) return
    this._rqtUnresolvedWarned = true
    safeLog(
      this.logger,
      "warn",
      "[HireFire] Request queue time samples dropped: process identity " +
        "is unresolved. Set HIREFIRE_SERVICE_NAME, or rely on DYNO / RENDER_SERVICE_NAME where " +
        "available.",
    )
  }

  _warnHerokuConflictOnce() {
    if (this._herokuConflictWarned) return
    if (!Identity.herokuConflict()) return
    this._herokuConflictWarned = true
    safeLog(
      this.logger,
      "warn",
      `[HireFire] HIREFIRE_SERVICE_NAME (${Identity.explicit()}) does not ` +
        `match the Heroku DYNO prefix (${Identity.herokuDyno()}). Heroku config vars ` +
        `are app-wide, so this makes every dyno identify as the same name. Set it inline per ` +
        `process in the Procfile, or unset it to use automatic detection.`,
    )
  }

  _warnCpuUnresolvedOnce() {
    if (this._cpuUnresolvedWarned) return
    this._cpuUnresolvedWarned = true
    safeLog(
      this.logger,
      "warn",
      "[HireFire] CPU metrics disabled: process identity is unresolved. " +
        "Set HIREFIRE_SERVICE_NAME, or rely on DYNO / RENDER_SERVICE_NAME where available.",
    )
  }
}

function coerceName(name) {
  const raw = name === undefined || name === null ? "" : String(name)
  const stripped = raw.trim()

  if (stripped.length === 0) {
    throw new TypeError(
      `config.dyno requires a dyno name as its first argument (got ${inspect(
        stripped,
      )}).`,
    )
  }

  if (Buffer.byteLength(stripped) > MAX_NAME_BYTES) {
    throw new TypeError(
      `config.dyno name exceeds ${MAX_NAME_BYTES} bytes (got ${Buffer.byteLength(
        stripped,
      )}).`,
    )
  }

  return stripped
}

function inspect(value) {
  return typeof value === "string" ? `"${value}"` : String(value)
}

Configuration.MissingSamplerError = MissingSamplerError
Configuration.DuplicateDynoError = DuplicateDynoError
Configuration.MAX_NAME_BYTES = MAX_NAME_BYTES

module.exports = Configuration
