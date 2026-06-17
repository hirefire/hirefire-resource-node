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

  get token() {
    return this._token ?? process.env.HIREFIRE_TOKEN ?? null
  }

  set token(value) {
    this._token = value
  }

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
            `config.dyno only tracks "cpu"; pass a sampler function for job metrics, ` +
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
          `(job metrics) or { tracking: "cpu" }. Only the "web" name implies http on its own; ` +
          `use config.service("${name}", { tracking: "http" }) for an http process under another name.`,
      )
    }

    this._register(name, collector, sampler)
  }

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
    // Case-insensitive: names differing only in case would gate as one identity.
    if (
      this._names.some(
        (existing) => existing.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new DuplicateDynoError(
        `Duplicate declaration for "${name}". Each dyno name maps to exactly one collector.`,
      )
    }

    // Reserve the name only after the collector validates and builds, so a
    // rejected declaration leaves no trace and a corrected retry still succeeds.
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
        )} for config.dyno/config.service; pass a sampler ` +
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
