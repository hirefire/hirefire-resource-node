class JobQueues {
  constructor() {
    this._jobQueues = []
  }

  add(jobQueue) {
    this._jobQueues.push(jobQueue)
  }

  any() {
    return this._jobQueues.length > 0
  }

  findByName(name) {
    const needle = String(name).toLowerCase()
    return (
      this._jobQueues.find(
        (jobQueue) => jobQueue.name.toLowerCase() === needle,
      ) || null
    )
  }

  [Symbol.iterator]() {
    return this._jobQueues[Symbol.iterator]()
  }
}

module.exports = JobQueues
