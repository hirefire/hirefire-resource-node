const Plan = require("../plan")
const { JQL, JQS } = require("../strategy")

const METHODS = {
  [JQL]: "jobQueueLatency",
  [JQS]: "jobQueueSize",
}

const PROBLEMS = {
  unknown_strategy: ({ strategy, name }) =>
    `Unknown plan strategy ${strategy} for ${name}. Entry skipped.`,
  unknown_adapter: ({ adapter, name }) =>
    `Unknown plan adapter ${adapter} for ${name}. Entry skipped.`,
  unloaded_adapter: ({ adapter, name }) =>
    `Plan adapter ${adapter} for ${name} is not loaded in this process. Entry skipped.`,
  unsupported_strategy: ({ adapter, strategy, name }) =>
    `Plan adapter ${adapter} does not support strategy ${strategy} for ${name}. Entry skipped.`,
  queues_not_a_list: ({ name }) =>
    `Plan queues for ${name} must be an array. Entry skipped.`,
  no_valid_queues: ({ name }) =>
    `Plan queue list for ${name} had no valid names. Entry skipped.`,
}

class Entry {
  constructor(raw) {
    this._raw = raw
    this.name = raw.name
    this.strategy = raw.strategy
    this.adapter = raw.adapter ?? ""
    this._adapter = Plan.adapter(this.adapter)
    this._validQueues = validQueues(raw.queues)
    this.problem = this.local ? this._localProblem() : this._adapterProblem()
  }

  get local() {
    return this.adapter === ""
  }

  get sampleable() {
    return !this.local && this.problem === null
  }

  get problemMessage() {
    return PROBLEMS[this.problem]({
      name: JSON.stringify(this.name),
      strategy: JSON.stringify(this.strategy),
      adapter: JSON.stringify(this.adapter),
    })
  }

  get key() {
    return [this.name, this.adapter, this.strategy].join("\0")
  }

  get queues() {
    return this._validQueues.slice(0, Plan.MAX_QUEUES)
  }

  get truncated() {
    return this._validQueues.length > Plan.MAX_QUEUES
  }

  get working() {
    return (
      typeof this._adapter.macro.jobQueueWorking === "function" &&
      (this.strategy === JQL || this._options().skipWorking === true)
    )
  }

  call() {
    return this._adapter.macro[METHODS[this.strategy]](...this.queues, {
      ...this._options(),
      ...this._adapter.connectionOptions(),
    })
  }

  callWorking() {
    return this._adapter.macro.jobQueueWorking(
      ...this.queues,
      this._adapter.connectionOptions(),
    )
  }

  _localProblem() {
    return Object.hasOwn(METHODS, this.strategy) ? null : "unknown_strategy"
  }

  _adapterProblem() {
    if (!this._adapter) return "unknown_adapter"
    if (!this._adapter.libraryLoaded()) return "unloaded_adapter"
    if (!this._adapter.supports(this.strategy)) return "unsupported_strategy"

    const listed = this._raw.queues
    if (listed != null && !Array.isArray(listed)) return "queues_not_a_list"
    if (this._validQueues.length === 0 && listed != null && listed.length > 0) {
      return "no_valid_queues"
    }
    return null
  }

  _options() {
    return this._adapter.options(this.strategy, this._raw.options)
  }
}

function validQueues(queues) {
  if (!Array.isArray(queues)) return []

  return queues
    .map((queue) => String(queue ?? "").trim())
    .filter(
      (name) => name && Buffer.byteLength(name) <= Plan.MAX_QUEUE_NAME_BYTES,
    )
}

module.exports = Entry
