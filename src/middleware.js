const HireFire = require(".")

// Samples this request's queue time (when a web collector and token are
// configured) and lazily starts the dispatcher. The push model serves no
// endpoint, so the middleware only observes — it never produces a response.
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

// X-Request-Start arrives in router-specific shapes: Heroku sends epoch
// milliseconds, nginx "t=" plus fractional epoch seconds, Apache "t=" plus epoch
// microseconds. The unit is inferred from the magnitude (the ranges are ~3
// orders apart); unparseable or implausible values yield null.
function calculateRequestQueueTime(requestStart) {
  const value = parseFloat(String(requestStart).replace(/^t=/, ""))
  if (!(value >= 1e9)) return null

  let milliseconds
  if (value < 1e11) {
    milliseconds = value * 1000 // epoch seconds
  } else if (value < 1e14) {
    milliseconds = value // epoch milliseconds
  } else {
    milliseconds = value / 1000 // epoch microseconds
  }

  return Math.max(Date.now() - Math.trunc(milliseconds), 0)
}

module.exports = { processRequestQueueTime, calculateRequestQueueTime }
