const { processRequestQueueTime } = require("../middleware")

function HireFireMiddlewareConnect(req, res, next) {
  // X-Queue-Start is an exact synonym for X-Request-Start (e.g. Render).
  processRequestQueueTime(
    req.headers["x-request-start"] || req.headers["x-queue-start"],
  )
  next()
}

module.exports = HireFireMiddlewareConnect
