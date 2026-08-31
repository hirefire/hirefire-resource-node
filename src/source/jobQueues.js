const safeLog = require("../log")

class JobQueues {
  constructor(configuration) {
    this._configuration = configuration

    this._jobQueues = []
  }

  add(jobQueue) {
    this._jobQueues.push(jobQueue)
  }

  any() {
    return this._jobQueues.length > 0
  }

  findByName(name) {
    const needle = String(name)
    return (
      this._jobQueues.find(
        (jobQueue) => jobQueue.name.toLowerCase() === needle.toLowerCase(),
      ) || null
    )
  }

  [Symbol.iterator]() {
    return this._jobQueues[Symbol.iterator]()
  }

  async sampleJobQueue(jobQueue, strategy, options) {
    if (!jobQueue) return

    const live = options && options.live
    const explicitName = options && options.name
    const reportName =
      explicitName == null || !String(explicitName).trim()
        ? jobQueue.name
        : String(explicitName).trim()
    strategy = String(strategy)
    if (strategy !== "jql" && strategy !== "jqs") {
      this._logger().error(
        `[HireFire] Unknown job-queue strategy ${JSON.stringify(
          strategy,
        )} for ` + `${JSON.stringify(reportName)}. Sample dropped.`,
      )
      return
    }

    try {
      const value = await jobQueue.sample()
      if (live && !live()) return

      if (!validSample(value)) {
        this._logger().error(
          `[HireFire] The sampler for ${JSON.stringify(reportName)} returned ` +
            `${inspect(
              value,
            )}, expected a non-negative number. Sample dropped.`,
        )
        return
      }

      this._configuration.buffer.sample(reportName, strategy, Number(value))
    } catch (error) {
      const reason =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : inspect(error)
      this._logger().error(
        `[HireFire] The sampler for ${JSON.stringify(
          reportName,
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
  try {
    const text = value === null ? "null" : typeof value
    let preview = String(value)
    if (Buffer.byteLength(preview) > 64) {
      preview = preview.slice(0, 64) + "…"
    }
    return `${text}(${JSON.stringify(preview)})`
  } catch {
    return typeof value
  }
}

module.exports = JobQueues
