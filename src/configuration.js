const { Web } = require('./web')
const { Worker } = require('./worker')

/**
 * Contains the configuration for the HireFire integration.
 *
 * @property {Web|null} web - Manages metrics for the web dyno. Null if not configured.
 * @property {Worker[]} workers - Manages metrics for configured worker dynos.
 * @property {Console} logger - Logger for output, defaults to console.
 */
class Configuration {
  /**
   * Constructs a new Configuration instance with default settings.
   */
  constructor () {
    this.web = null
    this.workers = []
    this.logger = console
  }

  /**
   * Configures a web or worker dyno for metric collection.
   * Validates dyno names and ensures the proper configuration of worker dynos.
   *
   * @param {string} name - The name of the dyno (proc) as specified in the Procfile.
   * @param {Function} [fn] - Optional function for worker dyno metric measurement, returning job queue metrics.
   * @throws {InvalidDynoNameError} - Thrown if the dyno name does not conform to Procfile naming conventions.
   * @throws {MissingDynoFnError} - Thrown if a required function is missing for worker dyno configuration.
   * @example
   * // Example: Configuring a web dyno
   * config.dyno('web');
   * @example
   * // Example: Configuring a worker dyno with a job queue measurement function
   * config.dyno('worker', async () => HireFireBullMQ.jobQueueSize('default'));
   */
  dyno (name, fn) {
    if (name === 'web') {
      this.web = new Web()
    } else {
      this.workers.push(new Worker(name, fn))
    }
  }
}

module.exports = { Configuration }
