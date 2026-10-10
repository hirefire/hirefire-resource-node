const Configuration = require("./configuration")
const Host = require("./host")
const Identity = require("./identity")

class HireFire {
  constructor() {
    this.configuration = new Configuration()
    this._stopped = false
  }

  configure(fn) {
    const result = fn(this.configuration)
    if (result != null && typeof result.then === "function") {
      throw new TypeError("HireFire.configure callbacks must be synchronous.")
    }
    this._stopped = false
    if (this._reports()) this.configuration.dispatcher.start()
    return this.configuration
  }

  boot() {
    return this.configure(() => {})
  }

  reset() {
    const dispatcher = this.configuration._dispatcher
    this.configuration = new Configuration()
    this._stopped = true
    return dispatcher ? dispatcher.stop() : Promise.resolve(false)
  }

  _reports() {
    const configuration = this.configuration
    return (
      Boolean(configuration.token) &&
      !this._stopped &&
      !Identity.oneOff() &&
      (configuration.forceStart || Host.reports())
    )
  }

  _handOver() {
    const configuration = this.configuration
    if (configuration.forceStart || !configuration._dispatcher) return

    configuration._dispatcher.stop({ flush: false }).catch(() => {})
  }
}

module.exports = HireFire
