const safeLog = require("./log")

// A collection of declared job collectors that knows how to sample them all.
class Workers {
  constructor(configuration) {
    this._configuration = configuration
    this._workers = []
  }

  add(worker) {
    this._workers.push(worker)
  }

  any() {
    return this._workers.length > 0
  }

  count() {
    return this._workers.length
  }

  map(fn) {
    return this._workers.map(fn)
  }

  [Symbol.iterator]() {
    return this._workers[Symbol.iterator]()
  }

  // Samplers are user code: isolate failures and validate values per worker.
  async sample() {
    for (const worker of this._workers) {
      try {
        const value = await worker.sample()

        if (!validSample(value)) {
          this._logger().error(
            `[HireFire] The sampler for dyno "${worker.name}" returned ` +
              `${inspect(
                value,
              )}; expected a non-negative number. Sample dropped.`,
          )
          continue
        }

        this._configuration.buffer.sampleWorker(worker.name, value)
      } catch (error) {
        // JS allows throwing non-Errors (throw null, Promise.reject("x")), so
        // reading .name/.message blindly could itself throw and break isolation.
        const reason =
          error instanceof Error
            ? `${error.name}: ${error.message}`
            : inspect(error)
        this._logger().error(
          `[HireFire] The sampler for dyno "${worker.name}" raised ${reason}`,
        )
      }
    }
  }

  // A throwing/incomplete user logger must not break sampler isolation.
  _logger() {
    const logger = this._configuration.logger
    return { error: (message) => safeLog(logger, "error", message) }
  }
}

function validSample(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function inspect(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value)
}

module.exports = Workers
