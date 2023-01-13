class MissingQueueError extends Error {
  constructor() {
    super("No queue was specified. Please specify at least one queue.")
    this.name = "MissingQueueError"
  }
}

class JobQueueLatencyUnsupportedError extends Error {
  constructor(name) {
    super(`${name} currently does not support job queue latency measurements.`)
    this.name = "JobQueueLatencyUnsupportedError"
  }
}

function jobQueueLatencyUnsupported(name) {
  throw new JobQueueLatencyUnsupportedError(name)
}

module.exports = {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
}
