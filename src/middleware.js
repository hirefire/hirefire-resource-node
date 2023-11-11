const HireFire = require('.')

/**
 * HireFireMiddlewareCore provides a framework-agnostic middleware for capturing and providing
 * metrics required for autoscaling Heroku web and worker dynos. This core middleware operates on
 * normalized request and response data, allowing it to be used across different server frameworks
 * like Express, Koa, and Connect.
 *
 * It primarily:
 * 1. Responds to specific HTTP requests with JSON-formatted queue metrics.
 * 2. Captures and processes request queue time data, forwarding it to `Web` for further handling.
 *
 * Processes the incoming request. It abstractly handles request queue time analysis and determines
 * the appropriate response, if any. This method operates on a normalized request information object
 * (`reqInfo`), making it framework-agnostic. The framework's middleware must convert the request
 * object into the normalized request information object, and then pass it to this method.
 *
 * Won't process the request if the `HIREFIRE_TOKEN` environment variable is not set.
 *
 * @param {Object} reqInfo - An object containing normalized request information with the following properties:
 *                           - path (string): The path of the request.
 *                           - requestStartTime (string | null): The start time of the request, or null if not available.
 * @returns {Object|null} Response object if the request matches the info path, otherwise null.
 */
async function request (reqInfo) {
  await processRequestQueueTime(reqInfo)

  if (matchesInfoPath(reqInfo)) {
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
 * Determines if the given request path aligns with the info path.
 *
 * @param {Object} reqInfo - An object containing normalized request information with the following properties:
 *                           - path (string): The path of the request.
 *                           - requestStartTime (string | null): The start time of the request, or null if not available.
 * @return {boolean} True if the request path aligns with the info path, otherwise false.
 */
function matchesInfoPath (reqInfo) {
  return process.env.HIREFIRE_TOKEN && reqInfo.path === `/hirefire/${process.env.HIREFIRE_TOKEN}/info`
}

/**
 * Calculate the request queue time from the `X-Request-Start` header and add it to the HireFire
 * web instance's buffer for processing.
 *
 * It also ensures that the Web instance is running, so that the request queue time information
 * can be periodically dispatched to HireFire's servers.
 *
 * @param {Object} reqInfo - An object containing normalized request information with the following properties:
 *                           - path (string): The path of the request.
 *                           - requestStartTime (string | null): The start time of the request, or null if not available.
 */
async function processRequestQueueTime (reqInfo) {
  if (process.env.HIREFIRE_TOKEN && HireFire.configuration.web && reqInfo.requestStartTime) {
    await HireFire.configuration.web.start()
    await HireFire.configuration.web.addToBuffer(
      calculateRequestQueueTime(reqInfo.requestStartTime)
    )
  }
}

/**
 * Calculates the time gap (in milliseconds) between the given `X-Request-Start` timestamp and the
 * present time.
 *
 * @param {string} timestamp - Timestamp from the `X-Request-Start` header.
 * @return {number} The computed queue time in milliseconds.
 */
function calculateRequestQueueTime (requestStartTime) {
  return Math.max(Date.now() - parseInt(requestStartTime, 10), 0)
}

module.exports = { request }
