const HireFire = require(".")

const REQUEST_QUEUE_TIME_LIMIT = 60000

// Observe-only: the push model serves no endpoint, so this never produces a
// response.
function processRequestQueueTime(requestStart) {
  if (!requestStart) return

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
}

// X-Request-Start's unit varies by router (epoch s / ms / µs / ns), so infer it
// from magnitude. Unparseable or implausible values yield null.
function calculateRequestQueueTime(requestStart) {
  const value = parseFloat(String(requestStart).replace(/^t=/, ""))
  if (!(value >= 1e9)) return null

  let milliseconds
  if (value < 1e11) {
    milliseconds = value * 1000 // epoch seconds
  } else if (value < 1e14) {
    milliseconds = value // epoch milliseconds
  } else if (value < 1e17) {
    milliseconds = value / 1000 // epoch microseconds
  } else {
    milliseconds = value / 1_000_000 // epoch nanoseconds
  }

  const requestQueueTime = Math.max(Date.now() - Math.round(milliseconds), 0)
  return requestQueueTime <= REQUEST_QUEUE_TIME_LIMIT ? requestQueueTime : null
}

module.exports = { processRequestQueueTime, calculateRequestQueueTime }
