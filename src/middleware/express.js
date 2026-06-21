const { processRequestQueueTime } = require("../middleware")

function HireFireMiddlewareExpress(req, res, next) {
  processRequestQueueTime(
    req.get("X-Request-Start") || req.get("X-Queue-Start"),
  )
  next()
}

module.exports = HireFireMiddlewareExpress
