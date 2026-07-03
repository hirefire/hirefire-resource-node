const HireFire = require(".")
const safeLog = require("./log")

const REQUEST_QUEUE_TIME_LIMIT = 60000

function processRequestQueueTime(requestStart) {
  if (!requestStart) return

  try {
    const requestQueueTime = calculateRequestQueueTime(requestStart)
    if (requestQueueTime === null) return

    const configuration = HireFire.configuration

    if (configuration.web && configuration.token) {
      configuration.web.sample(requestQueueTime)
      configuration.dispatcher.start()
    }

    if (configuration.logQueueMetrics) {
      console.log(`[hirefire:router] queue=${requestQueueTime}ms`)
    }
  } catch (error) {
    // Never raise the library's own bookkeeping into the host app's request.
    safeLog(
      HireFire.configuration.logger,
      "error",
      `[HireFire] Middleware error: ${error?.message ?? error}`,
    )
  }
}

function calculateRequestQueueTime(requestStart) {
  const value = parseFloat(String(requestStart).replace(/^t=/, ""))
  if (!(value >= 1e9)) return null

  let milliseconds
  if (value < 1e11) {
    milliseconds = value * 1000
  } else if (value < 1e14) {
    milliseconds = value
  } else if (value < 1e17) {
    milliseconds = value / 1000
  } else {
    milliseconds = value / 1_000_000
  }

  const requestQueueTime = Math.max(Date.now() - Math.round(milliseconds), 0)
  return requestQueueTime <= REQUEST_QUEUE_TIME_LIMIT ? requestQueueTime : null
}

module.exports = { processRequestQueueTime, calculateRequestQueueTime }
