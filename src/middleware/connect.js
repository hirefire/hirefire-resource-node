const { processRequestQueueTime } = require("../middleware")

/**
 * Connect middleware that samples request queue time from the `x-request-start` (or
 * `x-queue-start`) header on each request. Mount it before your routes with `app.use(...)`.
 *
 * When a token is present, records a queue-time sample under the process HTTP name, marks
 * HTTP active, and starts the dispatcher (and job-queue loop when lease race entry is true).
 * Explicit http registration is optional. Failures are logged and swallowed so the host app
 * is unaffected.
 *
 * @param {*} req - The Connect request.
 * @param {*} res - The Connect response.
 * @param {() => void} next - Passes control to the next handler.
 * @returns {void}
 */
function HireFireMiddlewareConnect(req, res, next) {
  processRequestQueueTime(
    req.headers["x-request-start"],
    req.headers["x-queue-start"],
  )
  next()
}

module.exports = HireFireMiddlewareConnect
