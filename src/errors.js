/**
 * Represents an error indicating the absence of queues.
 * This error is thrown when no queues are provided to a function that requires at least one queue.
 * @extends Error
 */
class MissingQueueError extends Error {
  /**
   * Constructs a new MissingQueueError instance.
   * Sets the error message to indicate the absence of queues.
   */
  constructor () {
    super('No queues were provided.')
    this.name = 'MissingQueueError'
  }
}

/**
 * Represents an error for unsupported job queue latency measurement.
 * This error is thrown when a job queue latency measurement is attempted
 * using a worker library that does not (currently) support this feature.
 * @extends Error
 */
class JobQueueLatencyUnsupportedError extends Error {
  /**
   * Constructs a new JobQueueLatencyUnsupportedError instance.
   *
   * @param {string} name - The name of the worker library that does not support
   *                        job queue latency measurements.
   */
  constructor (name) {
    super(`${name} currently does not support job queue latency measurements.`)
    this.name = 'JobQueueLatencyUnsupportedError'
  }
}

/**
 * Throws a JobQueueLatencyUnsupportedError.
 * This function is used in contexts where job queue latency measurements
 * are not supported by the worker library.
 *
 * @param {string} name - The name of the worker library that does not support
 *                        job queue latency measurements.
 * @throws {JobQueueLatencyUnsupportedError} - Thrown to indicate that the worker
 *                                             library does not support job queue
 *                                             latency measurements.
 */
function jobQueueLatencyUnsupported (name) {
  throw new JobQueueLatencyUnsupportedError(name)
}

module.exports = {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported
}
