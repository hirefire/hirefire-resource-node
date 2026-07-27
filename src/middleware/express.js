const { processRequestQueueTime } = require("../middleware")

/**
 * Express middleware that samples request queue time from the `X-Request-Start` (or
 * `X-Queue-Start`) header on each request. Mount it before your routes with `app.use(...)`.
 *
 * When a token is present, records a queue-time sample under the process HTTP name, marks
 * HTTP active, and starts the dispatcher (and job-queue loop when lease race entry is true).
 * Explicit http registration is optional. Failures are logged and swallowed so the host app
 * is unaffected.
 *
 * @param {*} req - The Express request.
 * @param {*} res - The Express response.
 * @param {() => void} next - Passes control to the next handler.
 * @returns {void}
 */
function HireFireMiddlewareExpress(req, res, next) {
  processRequestQueueTime(req.get("X-Request-Start"), req.get("X-Queue-Start"))
  next()
}

module.exports = HireFireMiddlewareExpress
