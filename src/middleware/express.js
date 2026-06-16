const { processRequestQueueTime } = require("../middleware")

function HireFireMiddlewareExpress(req, res, next) {
  // X-Queue-Start is an exact synonym for X-Request-Start (e.g. Render).
  processRequestQueueTime(
    req.get("X-Request-Start") || req.get("X-Queue-Start"),
  )
  next()
}

module.exports = HireFireMiddlewareExpress
