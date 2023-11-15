/**
 * Represents an error thrown when no queues are provided.
 */
class MissingQueueError extends Error {
  /**
   * Constructs the MissingQueueError instance.
   */
  constructor () {
    super('No queues were provided.')
    this.name = 'MissingQueueError'
  }
}

/**
 * Represents an error thrown when job queue latency measurement is unsupported.
 */
class JobQueueLatencyUnsupportedError extends Error {
  /**
   * Constructs the JobQueueLatencyUnsupportedError instance.
   *
   * @param {string} name - The name of the worker library that currently does not support job queue
   *                        latency measurements.
   */
  constructor (name) {
    super(`${name} currently does not support job queue latency measurements.`)
    this.name = 'JobQueueLatencyUnsupportedError'
  }
}

/**
 * Throws a JobQueueLatencyUnsupportedError.
 * This function is intended to be used in modules that do not support job queue latency measurements.
 *
 * @param {string} name - The name of the worker library that does not support job queue latency measurements.
 * @throws {JobQueueLatencyUnsupportedError} - Indicates that the worker library does not support job queue latency measurements.
 */
function jobQueueLatencyUnsupported (name) {
  throw new JobQueueLatencyUnsupportedError(name)
}

module.exports = {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported
}
