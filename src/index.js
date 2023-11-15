const { Configuration } = require('./configuration')

/**
 * The `HireFire` class serves as the primary interface for integrating the `hirefire-resource`
 * functionality into a JavaScript application. It provides a comprehensive configuration interface
 * for defining how HireFire collects, serves, and dispatches metrics, which are crucial for Heroku
 * autoscaling decisions made by dyno managers on HireFire. This class facilitates the configuration
 * of metric collection for both web and worker dynos and the customization of logging mechanisms.
 *
 * This setup is typically performed during the initialization phase of your application. Ensure
 * that the configuration is executed as part of the application boot process.
 *
 * @example
 * // Example: Configuring HireFire for web (i.e., Express) and worker (i.e., BullMQ) dynos
 * const HireFire = require('hirefire-resource')
 * const HireFireBullMQ = require('hirefire-resource/macro/bullmq')
 *
 * HireFire.configure(config => {
 *   // Set a custom logger for HireFire
 *   config.logger = console
 *
 *   // Configure HireFire to collect request queue time metrics and periodically
 *   // dispatch them. This matches the web dyno entry in the Procfile.
 *   config.dyno('web')
 *
 *   // Configure HireFire to measure BullMQ size across the default and mailer queues, and make
 *   // these metrics available to HireFire. This matches the worker dyno entry in the Procfile.
 *   config.dyno('worker', async () => HireFireBullMQ.jobQueueSize('default', 'mailer'))
 * })
 */
class HireFire {
  constructor () {
    /**
     * @type {Configuration}
     * The current configuration instance of the HireFire class. This instance is used to set up and
     * modify the behavior of HireFire in the context of metric collection and logger customization.
     */
    this.configuration = new Configuration()
  }

  /**
   * This method provides an interface to configure the HireFire instance. It accepts a function as
   * a parameter, which receives the current configuration instance. This function is used to modify
   * and set various configuration options.
   *
   * @param {function(Configuration): void} fn - The function to configure HireFire. This function
   * receives the current configuration object, allowing for the customization of metrics
   * collection, and logger settings.
   */
  configure (fn) {
    fn(this.configuration)
  }
}

module.exports = new HireFire()
