const { RQT } = require("../strategy")

class HTTP {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
  }

  get name() {
    return this._name
  }

  sample(requestQueueTime) {
    this._configuration.buffer.sample(this._name, RQT, requestQueueTime)
  }
}

module.exports = HTTP
