class Worker {
  constructor(name, sampler) {
    this._name = String(name)
    this._sampler = sampler
  }

  get name() {
    return this._name
  }

  async sample() {
    return this._sampler()
  }
}

module.exports = Worker
