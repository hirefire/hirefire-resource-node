const HireFire = require(".")
const pkg = require("../package.json")

class RequestInfo {
  constructor(path, requestStartTime = null) {
    this.path = path
    this.requestStartTime = requestStartTime
      ? parseInt(requestStartTime, 10)
      : null
  }
}

async function request(requestInfo) {
  await processRequestQueueTime(requestInfo)

  if (matchesInfoPath(requestInfo)) {
    return {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "must-revalidate, private, max-age=0",
        "HireFire-Resource": `Node-${pkg.version}`,
      },
      body: await Promise.all(
        HireFire.configuration.workers.map(async (worker) => ({
          name: worker.name,
          value: await worker.call(),
        })),
      ),
    }
  }

  return null
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
