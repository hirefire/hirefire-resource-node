class MissingQueueError extends Error {
  constructor(
    message = "No queue was specified. Please specify at least one queue.",
  ) {
    super(message)
    this.name = "MissingQueueError"
  }
}

class JobQueueLatencyUnsupportedError extends Error {
  constructor(name) {
    super(`${name} currently does not support job queue latency measurements.`)
    this.name = "JobQueueLatencyUnsupportedError"
  }
}

class MissingSamplerError extends Error {
  constructor(message) {
    super(message)
    this.name = "MissingSamplerError"
  }
}

class DuplicateDynoError extends Error {
  constructor(message) {
    super(message)
    this.name = "DuplicateDynoError"
  }
}

function jobQueueLatencyUnsupported(name) {
  throw new JobQueueLatencyUnsupportedError(name)
}

module.exports = {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  MissingSamplerError,
  DuplicateDynoError,
  jobQueueLatencyUnsupported,
}
