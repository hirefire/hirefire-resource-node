const { processRequestQueueTime } = require("../middleware")

function HireFireMiddlewareConnect(req, res, next) {
  processRequestQueueTime(
    () => req.headers["x-request-start"],
    () => req.headers["x-queue-start"],
  )
  next()
}

module.exports = HireFireMiddlewareConnect
