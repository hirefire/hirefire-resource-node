const { processRequestQueueTime } = require("../middleware")

function HireFireMiddlewareConnect(req, res, next) {
  processRequestQueueTime(req.headers["x-request-start"])
  next()
}

module.exports = HireFireMiddlewareConnect
