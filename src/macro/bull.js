const {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../errors")
const { sample, activity } = require("./helpers/sample_redis")
const { unpack } = require("../utility")

const STATES = ["wait", "paused", "active", "delayed", "priority"]

async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("Bull")
}

async function jobQueueSize(...args) {
  const { skipWorking } = unpack(args).options
  const due = (Date.now() + 1) * 0x1000 - 1

  return sample(
    args,
    STATES,
    (pipeline, key) => {
      pipeline.llen(`${key}wait`)
      pipeline.llen(`${key}paused`)
      pipeline.zcount(`${key}delayed`, "-inf", due)
      activity(pipeline, key)
    },
    ([wait, paused, delayed, [active, running]]) =>
      Number(wait) +
      Number(paused) +
      Number(delayed) +
      Number(active) -
      (skipWorking ? Number(running) : 0),
  )
}

async function jobQueueWorking(...args) {
  return sample(args, STATES, activity, ([[, running]]) => Number(running))
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  JobQueueLatencyUnsupportedError,
}
