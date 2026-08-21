const safeLog = require("../log")

class JobQueues {
  constructor(configuration) {
    this._configuration = configuration
    /**
     * @type {import("./jobQueue")[]}
     */
    this._jobQueues = []
  }

  add(jobQueue) {
    this._jobQueues.push(jobQueue)
  }

  any() {
    return this._jobQueues.length > 0
  }

  count() {
    return this._jobQueues.length
  }

  findByName(name) {
    const needle = String(name)
    return (
      this._jobQueues.find(
        (jobQueue) => jobQueue.name.toLowerCase() === needle.toLowerCase(),
      ) || null
    )
  }

  map(fn) {
    return this._jobQueues.map(fn)
  }

  [Symbol.iterator]() {
    return this._jobQueues[Symbol.iterator]()
  }

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
