const HireFire = require('.')

/**
 * Framework-agnostic middleware integration function for autoscaling Heroku web and worker dynos.
 * Works with normalized request data. It performs two key operations:
 *
 * 1. Capturing and processing request queue time data and forwarding it to the `Web` instance.
 * 2. Responding to specific HTTP requests with JSON-formatted job queue metrics from `Worker` instances.
 *
 * The caller (frameworks-specific middleware) is responsible for extracting the request path and
 * request start time from the request object and normalizing them into the `requestInfo` object.
 *
 * The function either returns a response object or null. If a response object is returned, the
 * caller is responsible for writing the response to the client. If null is returned, the caller
 * should proceed to the next middleware in the stack.
 *
 * Note that the 'HIREFIRE_TOKEN' environment variable is required to perform the above-mentioned operations.
 *
 * @param {Object} requestInfo - Normalized request information containing:
 *                               - path (string): The request path.
 *                               - requestStartTime (string | null): The request's start time, or null if unavailable.
 * @returns {Object|null} - Response object for matching info path requests; otherwise, null.
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
 * Checks if a request's path matches the predefined info path.
 *
 * @param {Object} requestInfo - Normalized request information containing:
 *                               - path (string): The request path.
 * @returns {boolean} - True if paths match, false otherwise.
 */
function matchesInfoPath (requestInfo) {
  return process.env.HIREFIRE_TOKEN && requestInfo.path === `/hirefire/${process.env.HIREFIRE_TOKEN}/info`
}

/**
 * Processes the request queue time and adds it to the Web instance's buffer.  Ensures that the web
 * instance is running to dispatch the queue time data to HireFire's servers.
 *
 * @param {Object} requestInfo - Normalized request information containing:
 *                               - requestStartTime (string | null): The request's start time, or null if unavailable.
 */
async function processRequestQueueTime (requestInfo) {
  if (process.env.HIREFIRE_TOKEN && HireFire.configuration.web && requestInfo.requestStartTime) {
    await HireFire.configuration.web.start()
    await HireFire.configuration.web.addToBuffer(
      calculateRequestQueueTime(requestInfo.requestStartTime)
    )
  }
}

/**
 * Calculates the request queue time in milliseconds.
 *
 * @param {string} requestStartTime - The request start time from the 'X-Request-Start' header.
 * @returns {number} - The queue time in milliseconds.
 */
function calculateRequestQueueTime (requestStartTime) {
  return Math.max(Date.now() - parseInt(requestStartTime, 10), 0)
}

module.exports = { request }
