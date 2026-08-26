const HireFire = require(".")
const safeLog = require("./log")

const REQUEST_QUEUE_TIME_LIMIT = 60000

function presentHeader(value) {
  if (value == null) return null
  const stripped = String(value).trim()
  return stripped.length > 0 ? stripped : null
}

function resolveRequestStart(requestStart, queueStart) {
  return presentHeader(requestStart) || presentHeader(queueStart)
}

function processRequestQueueTime(requestStart, queueStart) {
  try {
    const rawStart =
      typeof requestStart === "function" ? requestStart() : requestStart
    const rawQueue =
      typeof queueStart === "function" ? queueStart() : queueStart
    const header =
      arguments.length >= 2
        ? resolveRequestStart(rawStart, rawQueue)
        : presentHeader(rawStart)
    if (!header) return

    const requestQueueTime = calculateRequestQueueTime(header)
    if (requestQueueTime === null) return

    const configuration = HireFire.configuration

    if (configuration.token) {
      configuration.markHttpActive()
      const source = configuration.httpSource
      if (source) source.sample(requestQueueTime)
      configuration.dispatcher.start()
      configuration.dispatcher.ensureJobQueueLoop()
    }
  } catch (error) {
    safeLog(
      HireFire.configuration.logger,
      "error",
      `[HireFire] Middleware error: ${error?.message ?? error}`,
    )
  }
}

function calculateRequestQueueTime(requestStart) {
  const value = parseFloat(String(requestStart).replace(/^t=/, ""))
  if (!Number.isFinite(value)) return null
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

module.exports = {
  processRequestQueueTime,
  calculateRequestQueueTime,
  presentHeader,
  resolveRequestStart,
}
