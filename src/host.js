const cluster = require("cluster")
const {
  threadId,
  getEnvironmentData,
  setEnvironmentData,
} = require("worker_threads")

const KEY = "hirefire-resource"
const owner = getEnvironmentData(KEY)
const clientAbove = owner !== undefined && owner !== threadId
setEnvironmentData(KEY, threadId)

function startsAtBoot() {
  const forked = cluster.isPrimary && Object.keys(cluster.workers).length > 0
  return !clientAbove && !forked
}

module.exports = { startsAtBoot }
