const RQT = "rqt"
const JQL = "jql"
const JQS = "jqs"
const CPU = "cpu"
const WRK = "wrk"
const JOB_QUEUE = [JQL, JQS]

function rqt(strategy) {
  return String(strategy) === RQT
}

function jobQueue(strategy) {
  return JOB_QUEUE.includes(String(strategy))
}

module.exports = { RQT, JQL, JQS, CPU, WRK, JOB_QUEUE, rqt, jobQueue }
