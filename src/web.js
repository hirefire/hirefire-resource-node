class Web {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
  }

  get name() {
    return this._name
  }

  sample(requestQueueTime) {
    this._configuration.buffer.sampleWeb(requestQueueTime)
  }
}

module.exports = Web
