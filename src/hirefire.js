const Configuration = require("./configuration")

class HireFire {
  constructor() {
    this.configuration = new Configuration()
  }

  /**
   * Configures HireFire and starts reporting metrics. Passes the configuration object to the
   * callback so each process can declare what it tracks (see {@link Configuration#service} and
   * {@link Configuration#dyno}).
   *
   * After the callback runs, the dispatcher starts automatically when a token is present — set in
   * code (`config.token = ...`) or via the `HIREFIRE_TOKEN` environment variable. With no token
   * the app runs normally and reports nothing, so it is safe to leave configured in every
   * environment.
   *
   * @param {(config: Configuration) => void} fn - Callback that declares processes on the configuration.
   * @returns {Configuration} The configuration.
   * @example
   * hirefire.configure((config) => {
   *   config.service("web", { tracking: "http" })
   *   config.service("worker", () => jobQueueLatency("default"))
   *   config.service("encoder", { tracking: "cpu" })
   * })
   */
  configure(fn) {
    fn(this.configuration)
    if (this.configuration.token) this.configuration.dispatcher.start()
    return this.configuration
  }

  reset() {
    const dispatcher = this.configuration._dispatcher
    this.configuration = new Configuration()
    return dispatcher ? dispatcher.stop() : Promise.resolve(false)
  }
}

module.exports = HireFire
