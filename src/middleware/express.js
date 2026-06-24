const { processRequestQueueTime } = require("../middleware")

/**
 * Express middleware that samples request queue time from the `X-Request-Start` (or
 * `X-Queue-Start`) header on each request. Mount it before your routes with `app.use(...)`.
 *
 * @param {*} req - The Express request.
 * @param {*} res - The Express response.
 * @param {() => void} next - Passes control to the next handler.
 * @returns {void}
 */
function HireFireMiddlewareExpress(req, res, next) {
  processRequestQueueTime(
    req.get("X-Request-Start") || req.get("X-Queue-Start"),
  )
  next()
}

module.exports = HireFireMiddlewareExpress
