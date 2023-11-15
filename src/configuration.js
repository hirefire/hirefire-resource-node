const { Web } = require('./web')
const { Worker } = require('./worker')

/**
 * Represents an error when an invalid dyno name is provided.
 * Indicates that the provided name does not conform to the Procfile naming restrictions.
 */
class InvalidDynoNameError extends Error {
  constructor (message) {
    super(message)
    this.name = 'InvalidDynoNameError'
  }
}

/**
 * Represents an error when a required block is not provided for a worker dyno configuration.
 * Worker dynos must have a block that defines how to measure the job queue metric.
 */
class MissingDynoFnError extends Error {
  constructor (message) {
    super(message)
    this.name = 'MissingDynoFnError'
  }
}

/**
 * The Configuration class for HireFire.
 */
class Configuration {
  constructor () {
    /** @type {Web|null} The Web instance responsible for collecting and dispatching web metrics. */
    this.web = null

    /** @type {Worker[]} An array of Worker instances, each configured with a dyno name and a fn
     *                   defining its metric measurement logic.
     */
    this.workers = []

    /** @type {Console} The logger instance, defaulting to console if not otherwise configured. */
    this.logger = console
  }

  /**
   * Configures Web and Worker objects.
   * The fn is ignored for the Web object and required for Worker objects.
   * Throws errors for invalid names or missing fn.
   *
   * @param {string} name - The name of the dyno as declared in the Procfile.
   * @param {Function} fn - Required for worker dynos and returns an integer representing the job queue latency or job queue size metric.
   * @throws {InvalidDynoNameError} If the dyno name is invalid according to Procfile naming restrictions.
   * @throws {MissingDynoFnError} If a required fn is not provided for a worker dyno.
   * @example
   * // Configuring HireFire to dispatch web dyno metrics
   * const HireFire = require('hirefire-resource')
   * HireFire.configure(config => {
   *   config.dyno('web')
   * })
   * @example
   * // Configuring HireFire to measure and provide job queue metrics for a worker dyno
   * const HireFire = require('hirefire-resource')
   * const HireFireBullMQ = require('hirefire-resource/macro/bullmq')
   * HireFire.configure(config => {
   *   config.dyno('worker', async () => {
   *     return HireFireBullMQ.jobQueueSize('default')
   *   })
   * })
   */
  dyno (name, fn) {
    if (name === 'web') {
      this.web = new Web()
    } else if (/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/.test(name)) {
      if (fn) {
        this.workers.push(new Worker(name, fn))
      } else {
        throw new MissingDynoFnError(
          `Missing fn for Configuration#dyno(${name}). ` +
            'Ensure that you provide a fn that returns the queue metric.'
        )
      }
    } else {
      throw new InvalidDynoNameError(
        `Invalid name for Configuration#dyno(${name}). ` +
          'Ensure it matches the Procfile process name (i.e. web, worker).'
      )
    }
  }
}

module.exports = { Configuration, InvalidDynoNameError, MissingDynoFnError }
