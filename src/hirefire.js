const Configuration = require("./configuration")

/**
 * HireFire singleton entrypoint: configure processes and report metrics.
 */
class HireFire {
  constructor() {
    /**
     * The shared configuration for this HireFire instance.
     * @type {Configuration}
     */
    this.configuration = new Configuration()
  }

  /**
   * Configures HireFire and starts reporting metrics. Passes the configuration object to the
   * callback so each process can declare what it tracks (see {@link Configuration#service} and
   * {@link Configuration#dyno}).
   *
   * After the callback runs, the dispatcher starts automatically when a token is present, set in
   * code (`config.token = ...`) or via the `HIREFIRE_TOKEN` environment variable. With no token
   * the app runs normally and reports nothing, so it is safe to leave configured in every
   * environment.
   *
   * @param {(config: Configuration) => void} fn - Callback that declares processes on the configuration.
   * @returns {Configuration} The configuration.
   * @example
   * hirefire.configure((config) => {
   *   config.service("web", { tracking: "http" })
   *   config.service("worker", () => jobQueueSize("default"))
   *   config.service("encoder", { tracking: "cpu" })
   * })
   */
  configure(fn) {
    fn(this.configuration)
    if (this.configuration.token) this.configuration.dispatcher.start()
    return this.configuration
  }

  /**
   * Stops any running dispatcher and replaces the configuration with a fresh, empty one. Mainly
   * for tests and reconfiguration between runs.
   *
   * @returns {Promise<boolean>} Resolves once any running dispatcher has stopped. Resolves to
   *   `true` when a running dispatcher was stopped, or `false` when no dispatcher was running.
   */
  reset() {
    const dispatcher = this.configuration._dispatcher
    this.configuration = new Configuration()
    return dispatcher ? dispatcher.stop() : Promise.resolve(false)
  }
}

module.exports = HireFire
