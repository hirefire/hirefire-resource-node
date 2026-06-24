class JobQueueLatencyUnsupportedError extends Error {
  constructor(name) {
    super(`${name} currently does not support job queue latency measurements.`)
    this.name = "JobQueueLatencyUnsupportedError"
  }
}

/**
 * Throws {@link JobQueueLatencyUnsupportedError} for a queue library that has no latency metric.
 *
 * @param {string} name - The queue library name (e.g. "BullMQ").
 * @returns {never} Always throws.
 * @throws {JobQueueLatencyUnsupportedError} Always.
 */
function jobQueueLatencyUnsupported(name) {
  throw new JobQueueLatencyUnsupportedError(name)
}

module.exports = {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
}
