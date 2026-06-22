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
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
}
