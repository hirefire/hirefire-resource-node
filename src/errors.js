/**
 * Raised when a queue macro is called without any queue names and the backend requires them.
 */
class MissingQueueError extends Error {
  /**
   * @param {string} [message]
   */
  constructor(
    message = "No queue was specified. Please specify at least one queue.",
  ) {
    super(message)
    this.name = "MissingQueueError"
  }
}

/**
 * Raised when a queue library has no latency metric (e.g. BullMQ).
 */
class JobQueueLatencyUnsupportedError extends Error {
  /**
   * @param {string} name - The queue library name (e.g. "BullMQ").
   */
  constructor(name) {
    super(`${name} currently does not support job queue latency measurements.`)
    this.name = "JobQueueLatencyUnsupportedError"
  }
}

function jobQueueLatencyUnsupported(name) {
  throw new JobQueueLatencyUnsupportedError(name)
}

module.exports = {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
}
