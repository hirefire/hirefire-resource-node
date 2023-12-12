const HireFire = require(".")
const VERSION = require("./version")

class RequestInfo {
  constructor(path, requestStartTime = null, token = null) {
    this.path = path
    this.requestStartTime = requestStartTime
      ? parseInt(requestStartTime, 10)
      : null
    this.token = token
  }
}

async function request(requestInfo) {
  await processRequestQueueTime(requestInfo)

  if (matchesHireFirePath(requestInfo) || matchesInfoPath(requestInfo)) {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "must-revalidate, private, max-age=0",
        "HireFire-Resource": `Node-${VERSION}`,
      },
      body: await Promise.all(
        HireFire.configuration.workers.map(async (worker) => ({
          name: worker.name,
          value: await worker.value(),
        })),
      ),
    }
  }

  return null
}

function matchesHireFirePath(requestInfo) {
  return (
    process.env.HIREFIRE_TOKEN &&
    requestInfo.path === "/hirefire" &&
    requestInfo.token === process.env.HIREFIRE_TOKEN
  )
}

function matchesInfoPath(requestInfo) {
  return (
    process.env.HIREFIRE_TOKEN &&
    requestInfo.path === `/hirefire/${process.env.HIREFIRE_TOKEN}/info`
  )
}

async function processRequestQueueTime(requestInfo) {
  if (
    process.env.HIREFIRE_TOKEN &&
    HireFire.configuration.web &&
    requestInfo.requestStartTime
  ) {
    await HireFire.configuration.web.startDispatcher()
    await HireFire.configuration.web.addToBuffer(
      calculateRequestQueueTime(requestInfo),
    )
  }
}

function calculateRequestQueueTime(requestInfo) {
  return Math.max(Date.now() - requestInfo.requestStartTime, 0)
}

module.exports = { RequestInfo, request }
