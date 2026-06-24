const Web = require("./web")
const Worker = require("./worker")
const Workers = require("./workers")
const CPU = require("./cpu")
const Buffer = require("./buffer")
const Dispatcher = require("./dispatcher")
const Identity = require("./identity")
const safeLog = require("./log")

class MissingSamplerError extends Error {
  constructor(message) {
    super(message)
    this.name = "MissingSamplerError"
  }
}

class UnexpectedSamplerError extends Error {
  constructor(message) {
    super(message)
    this.name = "UnexpectedSamplerError"
  }
}

class UnknownCollectorError extends Error {
  constructor(message) {
    super(message)
    this.name = "UnknownCollectorError"
  }
}

class DuplicateDynoError extends Error {
  constructor(message) {
    super(message)
    this.name = "DuplicateDynoError"
  }
}

const SERVICE_COLLECTORS = { http: "http", cpu: "cpu" }
const DYNO_COLLECTORS = { cpu: "cpu" }

class Configuration {
  constructor() {
    this.logger = console
    this.web = null
    this.workers = new Workers(this)
    this.cpu = []
    this.logQueueMetrics = false
    this._names = []
    this._token = null
    this._buffer = null
    this._dispatcher = null
    this._identity = null
    this._identityResolved = false
  }

  /**
   * The HireFire API token. Reads the value set in code, else the `HIREFIRE_TOKEN` environment
   * variable, else `null`. When a token is present after {@link HireFire#configure}, the
   * dispatcher starts and metrics are reported.
   *
   * @type {string | null}
   */
  get token() {
    return this._token ?? process.env.HIREFIRE_TOKEN ?? null
  }

  set token(value) {
    this._token = value
  }

  /**
   * @overload
   * @param {string} name - The process name. The "web" name (case-insensitive) implies http.
   * @returns {void}
   */
  /**
   * @overload
   * @param {string} name - The process name. Must be non-empty.
   * @param {{ tracking: "cpu" }} options - Track this dyno's CPU utilization.
   * @returns {void}
   */
  /**
   * @overload
   * @param {string} name - The process name. Must be non-empty.
   * @param {() => number | Promise<number>} sampler - Returns the current job metric value.
   * @returns {void}
   */
  /**
   * Declares a process by dyno name. Like {@link Configuration#service}, but with two Procfile
   * conventions: the name "web" (case-insensitive) implies http on its own, and `"cpu"` is the
   * only `tracking` value it accepts.
   *
   * Resolution: `{ tracking: "cpu" }` tracks CPU, a sampler function tracks job metrics, and the
   * name "web" tracks http on its own. For an http process under a non-"web" name, use
   * `service(name, { tracking: "http" })`.
   *
   * @param {string} name - The process name. Must be non-empty.
   * @param {...(Function | { tracking: "cpu" })} args - A sampler function, or `{ tracking: "cpu" }`.
   * @returns {void}
   * @throws {TypeError} The name is empty, or an argument is neither a function nor an options object.
   * @throws {MissingSamplerError} A non-"web" name given with neither `{ tracking: "cpu" }` nor a sampler.
   * @throws {UnexpectedSamplerError} A sampler given alongside `{ tracking: "cpu" }`.
   * @throws {UnknownCollectorError} `tracking` given anything other than `"cpu"`.
   * @throws {DuplicateDynoError} The name was already declared, or a second http process was declared.
   * @example
   * config.dyno("web") // "web" implies http
   * config.dyno("worker", () => jobQueueSize("default"))
   * config.dyno("encoder", { tracking: "cpu" })
   */
  dyno(name, ...args) {
    name = coerceName(name)
    const { tracking, sampler } = parseArgs(args)

    let collector
    if (tracking !== undefined) {
      collector = DYNO_COLLECTORS[String(tracking)]
      if (!collector) {
        throw new UnknownCollectorError(
          `Unknown value ${inspect(
            tracking,
          )} for config.dyno("${name}", { tracking: ... }). ` +
            `config.dyno only tracks "cpu". Pass a sampler function for job metrics, ` +
            `or use config.service to track "http" explicitly.`,
        )
      }
    } else if (sampler) {
      collector = "job"
    } else if (name.toLowerCase() === "web") {
      collector = "http"
    } else {
      throw new MissingSamplerError(
        `config.dyno("${name}") could not be resolved: it needs a sampler function ` +
          `(job metrics) or { tracking: "cpu" }. Only the "web" name implies http on its own. ` +
          `Use config.service("${name}", { tracking: "http" }) for an http process under another name.`,
      )
    }

    this._register(name, collector, sampler)
  }

  /**
   * @overload
   * @param {string} name - The process name. Must be non-empty.
   * @param {{ tracking: "http" | "cpu" }} options - Track http request queue time, or CPU.
   * @returns {void}
   */
  /**
   * @overload
   * @param {string} name - The process name. Must be non-empty.
   * @param {() => number | Promise<number>} sampler - Returns the current job metric value.
   * @returns {void}
   */
  /**
   * Declares what a process tracks. The name is a label with no implicit meaning, so what to track
   * is always explicit. Pass exactly one of an options object with `tracking` or a sampler
   * function:
   *
   * - `{ tracking: "http" }`: web request queue-time metrics, sampled from this process's own HTTP
   *   traffic by the framework middleware (at most one http process per app process).
   * - a sampler function returning the current value: job queue metrics, typically via a queue
   *   macro (e.g. `jobQueueLatency`).
   * - `{ tracking: "cpu" }`: this process's CPU utilization.
   *
   * {@link Configuration#dyno} is this method plus the convention that the name "web"
   * implies `"http"`.
   *
   * @param {string} name - The process name. Must be non-empty.
   * @param {...(Function | { tracking: "http" | "cpu" })} args - A sampler function, or an options
   *   object with `tracking` set to `"http"` or `"cpu"`. Pass exactly one.
   * @returns {void}
   * @throws {TypeError} The name is empty, or an argument is neither a function nor an options object.
   * @throws {MissingSamplerError} Neither `tracking` nor a sampler was given.
   * @throws {UnexpectedSamplerError} A sampler given alongside `{ tracking: "http" }` or `"cpu"`.
   * @throws {UnknownCollectorError} `tracking` given an unsupported value.
   * @throws {DuplicateDynoError} The name was already declared, or a second http process was declared.
   * @example
   * config.service("web", { tracking: "http" })
   * config.service("worker", () => jobQueueSize("default"))
   * config.service("encoder", { tracking: "cpu" })
   */
  service(name, ...args) {
    name = coerceName(name)
    const { tracking, sampler } = parseArgs(args)

    let collector
    if (tracking !== undefined) {
      collector = SERVICE_COLLECTORS[String(tracking)]
      if (!collector) {
        throw new UnknownCollectorError(
          `Unknown value ${inspect(
            tracking,
          )} for config.service("${name}", { tracking: ... }). ` +
            `Expected { tracking: "http" } or { tracking: "cpu" }, or a sampler function for job metrics.`,
        )
      }
    } else if (sampler) {
      collector = "job"
    } else {
      throw new MissingSamplerError(
        `config.service("${name}") could not be resolved: pass { tracking: "http" }, ` +
          `{ tracking: "cpu" }, or a sampler function for job metrics.`,
      )
    }

    this._register(name, collector, sampler)
  }

  get buffer() {
    if (!this._buffer) this._buffer = new Buffer()
    return this._buffer
  }

  get dispatcher() {
    if (!this._dispatcher) {
      this._dispatcher = new Dispatcher(this, {
        web: this.web,
        workers: this.workers,
        cpu: this._activeCpuCollectors(),
        webLiveness: this._webLiveness(),
      })
    }
    return this._dispatcher
  }

  _register(name, collector, sampler) {
    if (
      this._names.some(
        (existing) => existing.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new DuplicateDynoError(
        `Duplicate declaration for "${name}". Each dyno name maps to exactly one collector.`,
      )
    }

    switch (collector) {
      case "http":
        this._rejectSampler(name, sampler)
        if (this.web) {
          throw new DuplicateDynoError(
            `"${name}" conflicts with the earlier http declaration for "${this.web.name}". ` +
              `Request metrics are collected from this process's own http traffic, so only one ` +
              `http collector can be declared, under any name.`,
          )
        }
        this.web = new Web(name, this)
        break
      case "job":
        if (!sampler)
          throw new MissingSamplerError(`Missing sampler for "${name}".`)
        this.workers.add(new Worker(name, sampler))
        break
      case "cpu":
        this._rejectSampler(name, sampler)
        this.cpu.push(new CPU(name, this))
        break
    }

    this._names.push(name)
  }

  _rejectSampler(name, sampler) {
    if (!sampler) return

    throw new UnexpectedSamplerError(
      `"${name}" does not take a sampler function (its values are collected automatically).`,
    )
  }

  _activeCpuCollectors() {
    if (this.cpu.length === 0) return []

    const identity = this._resolvedIdentity()

    if (identity === null) {
      safeLog(
        this.logger,
        "error",
        "[HireFire] CPU metrics are configured but this process's identity could not be " +
          "resolved, so the CPU collector is disabled. Set the HIREFIRE_SERVICE_NAME " +
          "environment variable to this process's dyno name.",
      )
      return []
    }

    return this.cpu.filter(
      (collector) => collector.name.toLowerCase() === identity.toLowerCase(),
    )
  }

  _webLiveness() {
    if (!this.web) return true

    const identity = this._resolvedIdentity()
    return (
      identity === null ||
      identity.toLowerCase() === this.web.name.toLowerCase()
    )
  }

  _resolvedIdentity() {
    if (this._identityResolved) return this._identity

    if (Identity.herokuConflict()) {
      safeLog(
        this.logger,
        "warn",
        `[HireFire] HIREFIRE_SERVICE_NAME (${Identity.explicit()}) does not match the Heroku ` +
          `DYNO prefix (${Identity.herokuDyno()}). Heroku config vars are app-wide, so this makes ` +
          `every dyno identify as the same name. Set it inline per process in the Procfile, or ` +
          `unset it to use automatic detection.`,
      )
    }

    this._identity = Identity.resolve()
    this._identityResolved = true
    return this._identity
  }
}

function coerceName(name) {
  name = name === undefined || name === null ? "" : String(name)

  if (name.length === 0) {
    throw new TypeError(
      'config.dyno and config.service require a dyno name as their first argument (got "").',
    )
  }

  return name
}

function parseArgs(args) {
  let tracking
  let sampler

  for (const arg of args) {
    if (typeof arg === "function") {
      sampler = arg
    } else if (arg && typeof arg === "object") {
      tracking = arg.tracking
    } else if (arg !== undefined && arg !== null) {
      throw new TypeError(
        `Invalid argument ${inspect(
          arg,
        )} for config.dyno/config.service. Pass a sampler ` +
          `function for job metrics, or an options object like { tracking: "cpu" }.`,
      )
    }
  }

  return { tracking, sampler }
}

function inspect(value) {
  return typeof value === "string" ? `"${value}"` : String(value)
}

Configuration.MissingSamplerError = MissingSamplerError
Configuration.UnexpectedSamplerError = UnexpectedSamplerError
Configuration.UnknownCollectorError = UnknownCollectorError
Configuration.DuplicateDynoError = DuplicateDynoError

module.exports = Configuration
