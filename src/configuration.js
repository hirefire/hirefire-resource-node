const { Web } = require('./web');
const { Worker } = require('./worker');

/**
 * Custom error indicating an invalid dyno name.
 * This error is thrown when a dyno name does not comply with the dyno naming standards on Heroku.
 */
class InvalidDynoNameError extends Error {
  /**
   * Constructs an InvalidDynoNameError instance with a specific error message.
   *
   * @param {string} message - Describes the issue with the invalid dyno name.
   */
  constructor(message) {
    super(message);
    this.name = 'InvalidDynoNameError';
  }
}

/**
 * Custom error indicating the absence of a required function in worker dyno configuration.
 * This error is thrown when the function necessary for measuring job queue metrics is missing.
 */
class MissingDynoFnError extends Error {
  /**
   * Constructs a MissingDynoFnError instance with a specific error message.
   *
   * @param {string} message - Describes the missing function issue in the worker dyno configuration.
   */
  constructor(message) {
    super(message);
    this.name = 'MissingDynoFnError';
  }
}

/**
 * Manages the configuration of web and worker dynos, including metrics collection and logging.
 *
 * @property {Web|null} web - Manages metrics for the web dyno. Null if not configured.
 * @property {Worker[]} workers - Manages metrics for configured worker dynos.
 * @property {Console} logger - Logger for output, defaults to console.
 */
class Configuration {
  /**
   * Constructs a new Configuration instance with default settings.
   */
  constructor() {
    this.web = null;
    this.workers = [];
    this.logger = console;
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
  dyno(name, fn) {
    if (name === 'web') {
      this.web = new Web();
    } else if (/^[a-zA-Z][a-zA-Z0-9_]{0,29}$/.test(name)) {
      if (fn) {
        this.workers.push(new Worker(name, fn));
      } else {
        throw new MissingDynoFnError(
          `Missing function for Configuration#dyno(${name}). ` +
          'A function is required to return the job queue metric for worker dynos.'
        );
      }
    } else {
      throw new InvalidDynoNameError(
        `Invalid dyno name for Configuration#dyno(${name}). ` +
        'Name must adhere to Procfile naming conventions.'
      );
    }
  }
}

module.exports = { Configuration, InvalidDynoNameError, MissingDynoFnError };
