/**
 * HTTP traffic source: samples request queue time into the `rqt` wire strategy.
 */
class HTTP {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
  }

  /**
   * The process name this source reports under.
   * @returns {string}
   */
  get name() {
    return this._name
  }

  /**
   * Records a request queue-time sample (milliseconds) under the `rqt` strategy.
   *
   * @param {number} requestQueueTime - Queue time in milliseconds.
   * @returns {void}
   */
  sample(requestQueueTime) {
    this._configuration.buffer.sample(this._name, "rqt", requestQueueTime)
  }
}

module.exports = HTTP
