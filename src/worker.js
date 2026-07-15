/**
 * Job-metric collector for a declared worker process.
 */
class Worker {
  constructor(name, sampler) {
    this._name = String(name)
    this._sampler = sampler
  }

  /**
   * The process name this collector reports under.
   * @returns {string}
   */
  get name() {
    return this._name
  }

  async sample() {
    return this._sampler()
  }
}

module.exports = Worker
