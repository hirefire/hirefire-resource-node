/**
 * HTTP request queue-time collector for a declared http process.
 */
class Web {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
  }

  /**
   * The process name this collector reports under.
   * @returns {string}
   */
  get name() {
    return this._name
  }

  sample(requestQueueTime) {
    this._configuration.buffer.sampleWeb(requestQueueTime)
  }
}

module.exports = Web
