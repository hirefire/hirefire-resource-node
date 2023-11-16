const HireFire = require('.')

/**
 * Represents normalized details of an HTTP request.
 *
 * @property {string} path - The request path.
 * @property {number|null} requestStartTime - The request start time in milliseconds, or null if not provided.
 */
class RequestInfo {
  /**
   * Initializes a new instance of the RequestInfo class with the given path and headers.
   *
   * @param {string} path - The request path.
   * @param {number|string} [requestStartTime=null] - The request start time in milliseconds.
   *                                                  If provided as a string, it is converted to a number.
   */
  constructor (path, requestStartTime = null) {
    this.path = path
    this.requestStartTime = requestStartTime ? parseInt(requestStartTime, 10) : null
  }
}

/**
 * Framework-agnostic middleware integration function for autoscaling Heroku web and worker dynos.
 * This function works with normalized request data and performs two key operations:
 *
 * 1. Captures and processes request queue time data, forwarding it to the `Web` instance.
 * 2. Responds to specific HTTP requests with JSON-formatted job queue metrics from `Worker` instances.
 *
 * The caller (framework-specific middleware) is responsible for extracting the request path and
 * request start time from the request object, normalizing them into a `RequestInfo` object.
 *
 * The function either returns a response object or null. A response object indicates that the
 * caller should write the response to the client. A null return value indicates that the caller
 * should proceed to the next middleware in the stack.
 *
 * Note: The 'HIREFIRE_TOKEN' environment variable is required to perform the operations.
 *
 * @async
 * @param {RequestInfo} requestInfo - Normalized request information.
 * @returns {Object|null} Response object for matching info path requests; otherwise, null.
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
 * Checks if the given request's path matches the predefined info path.
 *
 * @param {RequestInfo} requestInfo - Normalized request information.
 * @returns {boolean} True if the request path matches the predefined info path, false otherwise.
 */
function matchesInfoPath (requestInfo) {
  return process.env.HIREFIRE_TOKEN && requestInfo.path === `/hirefire/${process.env.HIREFIRE_TOKEN}/info`
}

/**
 * Processes the request queue time and adds it to the Web instance's buffer.  Ensures that the web
 * instance is running to dispatch the request queue time data to HireFire's servers.
 *
 * @async
 * @param {RequestInfo} requestInfo - Normalized request information.
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
 * Calculates the request queue time in milliseconds based on the `X-Request-Start` header value.
 *
 * @param {RequestInfo} requestInfo - Normalized request information.
 * @returns {number} The calculated queue time in milliseconds.
 */
function calculateRequestQueueTime (requestInfo) {
  return Math.max(Date.now() - requestInfo.requestStartTime, 0)
}

module.exports = { RequestInfo, request }
