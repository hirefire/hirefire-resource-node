const HireFire = require('.')

/**
 * Represents the normalized details of an HTTP request.
 *
 * @property {string} path - The path of the request.
 * @property {number|null} requestStartTime - The start time of the request in milliseconds, or null
 *                                            if not available.
 */
class RequestInfo {
  /**
   * Constructs a new instance of the RequestInfo class.
   *
   * @param {string} path - The path of the HTTP request.
   * @param {number|string|null} [requestStartTime=null] - The start time of the request in
   *                                                       milliseconds. If provided as a string, it
   *                                                       is converted to a number.
   */
  constructor (path, requestStartTime = null) {
    this.path = path
    this.requestStartTime = requestStartTime ? parseInt(requestStartTime, 10) : null
  }
}

/**
 * A framework-agnostic middleware function for capturing request queue time data and forwarding it
 * to the `Web` instance, as well as responding with JSON-formatted job queue metrics from `Worker`
 * instances.
 *
 * The function either returns a response object for specific requests for the caller to handle, or
 * null to indicate continuation of the middleware chain.
 *
 * @async
 * @param {RequestInfo} requestInfo - Normalized information about the HTTP request.
 * @returns {Promise<Object|null>} A response object for specific requests or null for other requests.
 */
async function request (requestInfo) {
  await processRequestQueueTime(requestInfo)

  if (matchesInfoPath(requestInfo)) {
    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'must-revalidate, private, max-age=0'
      },
      body: await Promise.all(
        HireFire.configuration.workers.map(async (worker) => ({
          name: worker.name,
          value: await worker.call()
        }))
      )
    }
  }

  return null
}

/**
 * Determines if the request path matches a predefined path for metrics reporting.
 *
 * @param {RequestInfo} requestInfo - Normalized information about the HTTP request.
 * @returns {boolean} True if the request path matches the predefined metrics path, false otherwise.
 */
function matchesInfoPath (requestInfo) {
  return process.env.HIREFIRE_TOKEN && requestInfo.path === `/hirefire/${process.env.HIREFIRE_TOKEN}/info`
}

/**
 * Processes and records the request queue time, updating the Web instance's buffer.
 * Ensures the Web instance is active for dispatching this data to HireFire's servers.
 *
 * @async
 * @param {RequestInfo} requestInfo - Normalized information about the HTTP request.
 */
async function processRequestQueueTime (requestInfo) {
  if (process.env.HIREFIRE_TOKEN && HireFire.configuration.web && requestInfo.requestStartTime) {
    await HireFire.configuration.web.start()
    await HireFire.configuration.web.addToBuffer(
      calculateRequestQueueTime(requestInfo)
    )
  }
}

/**
 * Calculates the request queue time for a request in milliseconds.
 *
 * @param {RequestInfo} requestInfo - Normalized information about the HTTP request.
 * @returns {number} The calculated request queue time in milliseconds.
 */
function calculateRequestQueueTime (requestInfo) {
  return Math.max(Date.now() - requestInfo.requestStartTime, 0)
}

module.exports = { RequestInfo, request }
