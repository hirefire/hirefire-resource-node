const { Configuration } = require('./configuration')

/**
 * The `HireFire` class is the main entry point for integrating the `hirefire-resource`
 * functionality into your application. It provides a configuration interface to define how HireFire
 * should collect, serve, and dispatch metrics required for Heroku autoscaling decisions made by
 * your dyno managers on HireFire. This class allows you to configure which metrics to collect for
 * web and worker dynos, and how these metrics should be gathered. You can also specify a custom
 * logger.
 *
 * This setup is typically done during the initialization phase of your application. The
 * configuration should be placed in a part of your codebase that is executed during application
 * boot.
 *
 * @example
 * // Configuring HireFire to collect metrics for web (i.e. Express) and worker (i.e. BullMQ)
 * const HireFire = require('hirefire-resource')
 *
 * HireFire.configure(config => {
 *   // Configure HireFire to use a custom logger
 *   config.logger = customLogger
 *
 *   // Configure HireFire to collect request queue time metrics and
 *   // periodically dispatch them. This matches the web dyno entry
 *   // in the Procfile.
 *   config.dyno('web');
 *
 *   // Configure HireFire to measure BullMQ job queue latency across
 *   // different priority queues, and make these metrics available
 *   // to HireFire. This matches the worker dyno entry in the Procfile.
 *   config.dyno('worker', () => {
 *     // Logic to measure BullMQ job queue latency
 *   });
 * });
 */
class HireFire {
  constructor () {
    /** @type {Configuration} The current configuration instance. */
    this.configuration = new Configuration()
  }

  /**
   * Yields the current configuration to a function, allowing for configuration of HireFire. This
   * method is typically called from an initialization file or any other setup script in your
   * application.
   *
   * @param {function(Configuration): void} configureFn - The function to configure HireFire.
   */
  configure (configureFn) {
    configureFn(this.configuration)
  }
}

module.exports = new HireFire()
