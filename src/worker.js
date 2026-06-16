// The job collector: a declared name and the user's sampler. The sampler may be
// sync or async; Workers awaits and validates it.
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
