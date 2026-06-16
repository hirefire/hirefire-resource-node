// The http collector for the HTTP-serving process; buffers one request queue
// time sample per request. The whole HTTP family rides this one feed, and the
// name need not be "web".
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
