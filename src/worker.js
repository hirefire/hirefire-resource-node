/**
 * Custom error indicating an invalid dyno name. This error is thrown when a dyno name does not
 * comply with the dyno naming standards on Heroku.
 */
class InvalidDynoNameError extends Error {
  /**
   * Constructs an InvalidDynoNameError instance with a specific error message.
   *
   * @param {string} message - Describes the issue with the invalid dyno name.
   */
  constructor (message) {
    super(message)
    this.name = 'InvalidDynoNameError'
  }
}

/**
 * Custom error indicating the absence of a required function in worker dyno configuration. This
 * error is thrown when the function necessary for measuring job queue metrics is missing.
 */
class MissingDynoFnError extends Error {
  /**
   * Constructs a MissingDynoFnError instance with a specific error message.
   *
   * @param {string} message - Describes the missing function issue in the worker dyno configuration.
   */
  constructor (message) {
    super(message)
    this.name = 'MissingDynoFnError'
  }
}

/**
 * The Worker class is designed for measuring job queue metrics of various worker libraries.
 * It is used to provide these metrics to HireFire's servers. The class requires both a name
 * (indicative of the worker dyno type in the Procfile) and a function defining the logic for
 * measuring the desired metric (like job queue latency or size) upon instantiation.
 */
class Worker {
  static PROCESS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,29}$/

  /**
   * Constructs a new Worker instance.
   * The `name` should align with the worker dyno designation in the Procfile, such as 'worker' or 'mailer'.
   * The `fn` is a function that calculates and returns a specific job queue metric, which can be based on
   * common measurement approaches using macros or custom logic.
   *
   * @param {string} name - The name of the worker, corresponding to the dyno name in the Procfile.
   * @param {function} fn - A function that calculates and returns a numeric value for the job queue metric.
   */
  constructor (name, fn) {
    this._validate(name, fn)
    this.name = name
    this.fn = fn
  }

  /**
   * Executes the metric calculation function provided during instantiation.
   * This method is asynchronous and returns a Promise that resolves with the calculated metric.
   * The metric must represent a quantifiable aspect of the job queue: either latency or size.
   *
   * @return {Promise<number>} A Promise resolving with the calculated queue metric as a number.
   */
  async call () {
    return this.fn()
  }

  _validate (name, fn) {
    if (!Worker.PROCESS_NAME_PATTERN.test(name || '')) {
      throw new InvalidDynoNameError(
        `Invalid name for new Worker(${name}, fn). ` +
          'Ensure it matches the Procfile process name (i.e. web, worker).'
      )
    }

    if (!fn || typeof fn !== 'function') {
      throw new MissingDynoFnError(
        `Missing function for new Worker(${name}, fn). ` +
          'Ensure that you provide a function that returns the job queue metric.'
      )
    }
  }
}

module.exports = { Worker }
