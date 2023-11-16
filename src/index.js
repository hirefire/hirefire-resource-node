const { Configuration } = require('./configuration')

/**
 * Main interface for integrating `hirefire-resource` functionality into a Node.js application. This
 * class facilitates the configuration of metric collection, dispatching and serving, for Heroku
 * dyno autoscaling with HireFire. It supports metrics configuration for both web and worker dynos
 * and offers logger customization. It is typically instantiated during the application's
 * initialization phase.
 *
 * @example
 * // Example: Configuring HireFire for web and worker dynos with BullMQ
 * const HireFire = require('hirefire-resource');
 * const HireFireBullMQ = require('hirefire-resource/macro/bullmq');
 *
 * HireFire.configure(config => {
 *   config.logger = console;
 *   config.dyno('web');
 *   config.dyno('worker', async () => HireFireBullMQ.jobQueueSize('default'));
 * });
 */
class HireFire {
  /**
   * Creates a new HireFire instance.
   * Initializes the configuration settings for HireFire behavior.
   */
  constructor () {
    /**
     * The current configuration instance of the HireFire class.
     * Utilized for setting and adjusting metric collection and logger configurations.
     * @type {Configuration}
     */
    this.configuration = new Configuration()
  }

  /**
   * Configures the HireFire instance.
   * This method accepts a function that receives and modifies the current configuration.
   *
   * @param {function(Configuration): void} fn - A function that takes a Configuration object
   *                                            to customize the metric collection and logger settings.
   */
  configure (fn) {
    fn(this.configuration)
  }
}

module.exports = new HireFire()
