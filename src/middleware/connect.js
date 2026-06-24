const { processRequestQueueTime } = require("../middleware")

/**
 * Connect middleware that samples request queue time from the `x-request-start` (or
 * `x-queue-start`) header on each request. Mount it before your routes with `app.use(...)`.
 *
 * @param {*} req - The Connect request.
 * @param {*} res - The Connect response.
 * @param {() => void} next - Passes control to the next handler.
 * @returns {void}
 */
function HireFireMiddlewareConnect(req, res, next) {
  processRequestQueueTime(
    req.headers["x-request-start"] || req.headers["x-queue-start"],
  )
  next()
}

module.exports = HireFireMiddlewareConnect
