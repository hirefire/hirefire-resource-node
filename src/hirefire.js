const Configuration = require("./configuration")

class HireFire {
  constructor() {
    this.configuration = new Configuration()
  }

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
