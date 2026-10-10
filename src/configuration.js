const HTTP = require("./source/http")
const JobQueue = require("./source/jobQueue")
const JobQueues = require("./source/jobQueues")
const CPU = require("./source/cpu")
const MetricsBuffer = require("./buffer")
const Dispatcher = require("./dispatcher")
const Identity = require("./identity")
const Once = require("./once")

class MissingSamplerError extends Error {
  constructor(message) {
    super(message)
    this.name = "MissingSamplerError"
  }
}

class DuplicateDynoError extends Error {
  constructor(message) {
    super(message)
    this.name = "DuplicateDynoError"
  }
}

const { MAX_NAME_BYTES } = Identity

class Configuration {
  #token = null

  constructor() {
    this.http = null
    this.jobQueues = new JobQueues()
    this.logger = console
    this.forceStart = false
    this._sourcesByName = new Map()
    this._buffer = null
    this._dispatcher = null
    this._alwaysOnCpu = null
    this._alwaysOnHttp = null
    this._httpActive = false
    this._once = new Once(this)
  }

  get token() {
    const value = this.#token ?? process.env.HIREFIRE_TOKEN
    if (value == null) return null
    const stripped = String(value).trim()
    return stripped.length > 0 ? stripped : null
  }

  set token(value) {
    this.#token = value
  }

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
        `middleware traffic. CPU is always-on when process identity resolves. ` +
        `Bare config.dyno("web") is a no-op and can be removed.`,
    )
  }

  get buffer() {
    if (!this._buffer) this._buffer = new MetricsBuffer()
    return this._buffer
  }

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
    return this.rqtEnabled && this._softIdentity() != null
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

  _warnPlainHttpDataUrlOnce(host) {
    this._once.log(
      "warn",
      "plain_http_data_url",
      null,
      "[HireFire] HIREFIRE_DATA_URL uses http, so the HireFire token " +
        `is sent to ${host} in clear text. Use an https URL.`,
    )
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
      this.jobQueues.add(new JobQueue(name, sampler))
    }

    this._sourcesByName.set(key, kinds.concat(source))
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
    this._once.log(
      "error",
      "identity_name_too_long",
      null,
      `[HireFire] Process identity exceeds ${MAX_NAME_BYTES} bytes ` +
        `(${Buffer.byteLength(
          name,
        )}). Metrics under this identity are disabled until the name is shortened.`,
    )
  }

  _warnBareWebDynoOnce() {
    this._once.log(
      "warn",
      "bare_web_dyno",
      null,
      '[HireFire] config.dyno("web") is deprecated. It does nothing. ' +
        "Request queue time is sampled automatically from HTTP traffic. You can remove this " +
        "line. Leaving it does not break anything.",
    )
  }

  _warnRqtUnresolvedOnce() {
    this._once.log(
      "warn",
      "rqt_unresolved",
      null,
      "[HireFire] Request queue time samples dropped: process identity " +
        "is unresolved. Set HIREFIRE_SERVICE_NAME or DYNO.",
    )
  }

  _warnHerokuConflictOnce() {
    if (!Identity.herokuConflict()) return
    this._once.log(
      "warn",
      "heroku_conflict",
      null,
      `[HireFire] HIREFIRE_SERVICE_NAME (${Identity.explicit()}) does not ` +
        `match the Heroku DYNO prefix (${Identity.herokuDyno()}). Heroku config vars ` +
        `are app-wide, so this makes every dyno identify as the same name. Set it inline per ` +
        `process in the Procfile, or unset it to use automatic detection.`,
    )
  }

  _warnCpuUnresolvedOnce() {
    this._once.log(
      "warn",
      "cpu_unresolved",
      null,
      "[HireFire] CPU metrics disabled: process identity is unresolved. " +
        "Set HIREFIRE_SERVICE_NAME or DYNO.",
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
