const safeLog = require("../log")

/**
 * Collection of local {@link JobQueue} sources declared on the configuration.
 */
class JobQueues {
  /**
   * @param {import("../configuration")} configuration
   */
  constructor(configuration) {
    this._configuration = configuration
    /**
     * @type {import("./jobQueue")[]}
     */
    this._jobQueues = []
  }

  /**
   * @param {import("./jobQueue")} jobQueue
   * @returns {void}
   */
  add(jobQueue) {
    this._jobQueues.push(jobQueue)
  }

  /**
   * @returns {boolean}
   */
  any() {
    return this._jobQueues.length > 0
  }

  /**
   * @returns {number}
   */
  count() {
    return this._jobQueues.length
  }

  /**
   * Case-insensitive match. Returned source keeps its canonical declared name for emit.
   *
   * @param {string} name
   * @returns {import("./jobQueue") | null}
   */
  findByName(name) {
    const needle = String(name)
    return (
      this._jobQueues.find(
        (jobQueue) => jobQueue.name.toLowerCase() === needle.toLowerCase(),
      ) || null
    )
  }

  /**
   * @template T
   * @param {(jobQueue: import("./jobQueue")) => T} fn
   * @returns {T[]}
   */
  map(fn) {
    return this._jobQueues.map(fn)
  }

  /**
   * @returns {IterableIterator<import("./jobQueue")>}
   */
  [Symbol.iterator]() {
    return this._jobQueues[Symbol.iterator]()
  }

  /**
   * Samples a job-queue source and buffers a valid metric under the given wire strategy.
   *
   * @param {import("./jobQueue")} jobQueue
   * @param {string} strategy - `jql` or `jqs`
   * @param {{ live?: () => boolean }} [options]
   * @returns {Promise<void>}
   */
  async sampleJobQueue(jobQueue, strategy, options) {
    if (!jobQueue) return

    const live = options && options.live
    strategy = String(strategy)
    if (strategy !== "jql" && strategy !== "jqs") {
      this._logger().error(
        `[HireFire] Unknown job-queue strategy ${JSON.stringify(
          strategy,
        )} for ` + `${JSON.stringify(jobQueue.name)}. Sample dropped.`,
      )
      return
    }

    try {
      const value = await jobQueue.sample()
      if (live && !live()) return

      if (!validSample(value)) {
        this._logger().error(
          `[HireFire] The sampler for ${JSON.stringify(
            jobQueue.name,
          )} returned ` +
            `${inspect(
              value,
            )}, expected a non-negative number. Sample dropped.`,
        )
        return
      }

      this._configuration.buffer.sample(jobQueue.name, strategy, Number(value))
    } catch (error) {
      const reason =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : inspect(error)
      this._logger().error(
        `[HireFire] The sampler for ${JSON.stringify(
          jobQueue.name,
        )} raised ${reason}`,
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

module.exports = JobQueues
