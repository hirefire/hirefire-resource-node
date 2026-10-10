const HireFire = require(".")
const { formatError } = require("./log")
const { presence } = require("./utility")

const REQUEST_QUEUE_TIME_LIMIT = 60000

function processRequestQueueTime(requestStart, queueStart) {
  try {
    const rawStart =
      typeof requestStart === "function" ? requestStart() : requestStart
    const rawQueue =
      typeof queueStart === "function" ? queueStart() : queueStart
    const header = presence(rawStart) || presence(rawQueue)
    if (!header) return

    const requestQueueTime = calculateRequestQueueTime(header)
    if (requestQueueTime === null) return

    const configuration = HireFire.configuration

    if (HireFire._reports()) {
      configuration.markHttpActive()
      const source = configuration.httpSource
      if (source) source.sample(requestQueueTime)
      configuration.dispatcher.start()
    }
  } catch (error) {
    HireFire.configuration._once.log(
      "error",
      "middleware_error",
      error?.constructor?.name,
      `[HireFire] Middleware error: ${formatError(error)}`,
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

module.exports = { processRequestQueueTime }
