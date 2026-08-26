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
   * Configures HireFire and starts reporting metrics when a token is present. Yields the
   * configuration object so each process can declare local sources (see
   * {@link Configuration#dyno}). Zero-config installs can use {@link HireFire#boot} instead.
   *
   * After the callback runs, the dispatcher starts automatically when a token is present, set in
   * code (`config.token = ...`) or via the `HIREFIRE_TOKEN` environment variable. With no token
   * the app runs normally and reports nothing, so it is safe to leave configured in every
   * environment.
   *
   * Configuration is additive: a later {@link HireFire#configure} may add local job-queue samplers
   * without {@link HireFire#reset}. Lease race entry and the job-queue loop are re-evaluated so
   * late job-queue samplers take effect.
   *
   * @param {(config: Configuration) => void} fn - Callback that declares processes on the configuration.
   * @returns {Configuration} The configuration.
   * @example
   * hirefire.configure((config) => {
   *   config.dyno("worker", () => jobQueueSize("default"))
   * })
   */
  configure(fn) {
    fn(this.configuration)
    this._startIfToken()
    return this.configuration
  }

  /**
   * Starts HireFire with no local source declarations.
   *
   * Equivalent to {@link HireFire#configure} with an empty callback. Use for zero-config installs
   * that rely on always-on request queue time and CPU, plus lease plan macros for job-queue
   * metrics. Full {@link HireFire#configure} remains available for local job-queue samplers via
   * {@link Configuration#dyno}.
   *
   * @returns {Configuration} The configuration.
   * @example
   * hirefire.boot()
   */
  boot() {
    return this.configure(() => {})
  }

  /**
   * Stops any running dispatcher and replaces the configuration with a fresh, empty one. Mainly
   * for tests and reconfiguration between runs. Consumers must `await` this method.
   *
   * @returns {Promise<boolean>} Resolves once any running dispatcher has stopped. Resolves to
   *   `true` when a running dispatcher was stopped, or `false` when no dispatcher was running.
   */
  reset() {
    const old = this.configuration
    const dispatcher = old._dispatcher
    this.configuration = new Configuration()
    return dispatcher ? dispatcher.stop() : Promise.resolve(false)
  }

  _startIfToken() {
    if (!this.configuration.token) return
    this.configuration.dispatcher.start()
    this.configuration.dispatcher.ensureJobQueueLoop()
  }
}

module.exports = HireFire
