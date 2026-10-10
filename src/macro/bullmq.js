const {
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../errors")
const { sample } = require("./helpers/sample_redis")
const { unpack } = require("../utility")

const STATES = ["wait", "paused", "active", "delayed", "prioritized"]

async function jobQueueLatency(...args) {
  jobQueueLatencyUnsupported("BullMQ")
}

async function jobQueueSize(...args) {
  const { skipWorking } = unpack(args).options
  const due = (Date.now() + 1) * 0x1000 - 1

  return sample(
    args,
    STATES,
    (pipeline, key) => {
      pipeline.lindex(`${key}wait`, -1)
      pipeline.llen(`${key}wait`)
      pipeline.llen(`${key}paused`)
      pipeline.lindex(`${key}paused`, -1)
      pipeline.zcount(`${key}delayed`, "-inf", due)
      pipeline.zcard(`${key}prioritized`)
      pipeline.llen(`${key}active`)
    },
    ([lastWait, wait, paused, lastPaused, delayed, prioritized, active]) =>
      Number(wait) +
      Number(paused) +
      Number(delayed) +
      Number(prioritized) +
      (skipWorking ? 0 : Number(active)) -
      (marker(lastWait) || marker(lastPaused) ? 1 : 0),
  )
}

async function jobQueueWorking(...args) {
  return sample(
    args,
    STATES,
    (pipeline, key) => pipeline.llen(`${key}active`),
    ([active]) => Number(active),
  )
}

function marker(job) {
  return typeof job === "string" && job.startsWith("0:")
}

module.exports = {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  JobQueueLatencyUnsupportedError,
}
