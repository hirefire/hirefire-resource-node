const cluster = require("cluster")
const { isMainThread } = require("worker_threads")

function reports() {
  const forked = cluster.isPrimary && Object.keys(cluster.workers).length > 0
  return isMainThread && !forked
}

module.exports = { reports }
