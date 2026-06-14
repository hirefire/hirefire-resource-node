// The job collector: holds a declared name and the user's sampler function,
// which queries shared job-queue state (queue size or latency). The sampler may
// be synchronous or async; the Workers collection awaits and validates it.
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
