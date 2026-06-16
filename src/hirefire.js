const Configuration = require("./configuration")

class HireFire {
  constructor() {
    this.configuration = new Configuration()
  }

  configure(fn) {
    fn(this.configuration)
    // Start here (not only from the middleware) so worker- and CPU-only
    // processes, which receive no web requests, still dispatch.
    if (this.configuration.token) this.configuration.dispatcher.start()
    return this.configuration
  }

  // Stops the current dispatcher and installs a fresh configuration. Returns the
  // stop promise so callers (chiefly tests) can await the final flush.
  reset() {
    const dispatcher = this.configuration._dispatcher
    this.configuration = new Configuration()
    return dispatcher ? dispatcher.stop() : Promise.resolve(false)
  }
}

module.exports = HireFire
