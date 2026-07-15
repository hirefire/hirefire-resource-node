const safeLog = require("./log")

/**
 * Collection of job-metric Worker collectors declared on the configuration.
 */
class Workers {
  /**
   * @param {import("./configuration")} configuration
   */
  constructor(configuration) {
    this._configuration = configuration
    /**
     * @type {import("./worker")[]}
     */
    this._workers = []
  }

  /**
   * @param {import("./worker")} worker
   */
  add(worker) {
    this._workers.push(worker)
  }

  /**
   * @returns {boolean}
   */
  any() {
    return this._workers.length > 0
  }

  /**
   * @returns {number}
   */
  count() {
    return this._workers.length
  }

  /**
   * @template T
   * @param {(worker: import("./worker")) => T} fn
   * @returns {T[]}
   */
  map(fn) {
    return this._workers.map(fn)
  }

  /**
   * @returns {IterableIterator<import("./worker")>}
   */
  [Symbol.iterator]() {
    return this._workers[Symbol.iterator]()
  }

  /**
   * @returns {Promise<void>}
   */
  async sample() {
    for (const worker of this._workers) {
      try {
        const value = await worker.sample()

        if (!validSample(value)) {
          this._logger().error(
            `[HireFire] The sampler for dyno "${worker.name}" returned ` +
              `${inspect(
                value,
              )}, expected a non-negative number. Sample dropped.`,
          )
          continue
        }

        this._configuration.buffer.sampleWorker(worker.name, value)
      } catch (error) {
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
