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
   * Adds a worker collector to the collection.
   *
   * @param {import("./worker")} worker
   * @returns {void}
   */
  add(worker) {
    this._workers.push(worker)
  }

  /**
   * Whether the collection has at least one worker.
   *
   * @returns {boolean}
   */
  any() {
    return this._workers.length > 0
  }

  /**
   * Number of worker collectors in the collection.
   *
   * @returns {number}
   */
  count() {
    return this._workers.length
  }

  /**
   * Case-insensitive match. Returned source keeps its canonical declared name for emit.
   *
   * @param {string} name
   * @returns {import("./worker") | null}
   */
  findByName(name) {
    const needle = String(name)
    return (
      this._workers.find(
        (worker) => worker.name.toLowerCase() === needle.toLowerCase(),
      ) || null
    )
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
   * Samples a job-queue worker and buffers a valid metric under the given wire strategy.
   *
   * @param {import("./worker")} worker
   * @param {string} strategy - `jql` or `jqs`
   * @returns {Promise<void>}
   */
  async sampleJobQueue(worker, strategy) {
    if (!worker) return

    strategy = String(strategy)
    if (strategy !== "jql" && strategy !== "jqs") {
      this._logger().error(
        `[HireFire] Unknown job-queue strategy ${JSON.stringify(
          strategy,
        )} for ` + `${JSON.stringify(worker.name)}. Sample dropped.`,
      )
      return
    }

    try {
      const value = await worker.sample()

      if (!validSample(value)) {
        this._logger().error(
          `[HireFire] The sampler for dyno "${worker.name}" returned ` +
            `${inspect(
              value,
            )}, expected a non-negative number. Sample dropped.`,
        )
        return
      }

      this._configuration.buffer.sample(worker.name, strategy, Number(value))
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
