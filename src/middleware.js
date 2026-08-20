const HireFire = require(".")
const safeLog = require("./log")

const REQUEST_QUEUE_TIME_LIMIT = 60000

/**
 * Strip header values. Blank / whitespace-only values are absent so an empty
 * Request-Start does not block Queue-Start fallback.
 *
 * @param {string|null|undefined} value
 * @returns {string|null}
 */
function presentHeader(value) {
  if (value == null) return null
  const stripped = String(value).trim()
  return stripped.length > 0 ? stripped : null
}

/**
 * Prefer X-Request-Start, then X-Queue-Start.
 *
 * @param {string|null|undefined} requestStart
 * @param {string|null|undefined} queueStart
 * @returns {string|null}
 */
function resolveRequestStart(requestStart, queueStart) {
  return presentHeader(requestStart) || presentHeader(queueStart)
}

/**
 * @param {string|null|undefined} requestStart
 * @param {string|null|undefined} [queueStart]
 */
/**
 * Logplex QueueTime BC: exact 1.x stdout shape. No token required.
 *
 * @param {number} requestQueueTime
 */
function logRequestQueueTime(requestQueueTime) {
  console.log(`[hirefire:router] queue=${requestQueueTime}ms`)
}

function processRequestQueueTime(requestStart, queueStart) {
  const header =
    arguments.length >= 2
      ? resolveRequestStart(requestStart, queueStart)
      : presentHeader(requestStart)
  if (!header) return

  try {
    const requestQueueTime = calculateRequestQueueTime(header)
    if (requestQueueTime === null) return

    const configuration = HireFire.configuration

    if (configuration.logQueueMetrics) {
      logRequestQueueTime(requestQueueTime)
    }

    if (configuration.token) {
      configuration.markHttpActive()
      configuration.dispatcher.start()
      configuration.dispatcher.ensureJobQueueLoop()
      try {
        const source = configuration.httpSource
        if (source) source.sample(requestQueueTime)
      } catch (sampleError) {
        safeLog(
          configuration.logger,
          "error",
          `[HireFire] Middleware error: ${sampleError?.message ?? sampleError}`,
        )
      }
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
  logRequestQueueTime,
  presentHeader,
  resolveRequestStart,
}
