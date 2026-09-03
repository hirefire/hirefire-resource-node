const Configuration = require("./configuration")

class HireFire {
  constructor() {
    this.configuration = new Configuration()
  }

  configure(fn) {
    const result = fn(this.configuration)
    if (result != null && typeof result.then === "function") {
      throw new TypeError("HireFire.configure callbacks must be synchronous.")
    }
    this._startIfToken()
    return this.configuration
  }

  boot() {
    return this.configure(() => {})
  }

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
