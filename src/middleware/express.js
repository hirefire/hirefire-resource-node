const { processRequestQueueTime } = require("../middleware")

function HireFireMiddlewareExpress(req, res, next) {
  processRequestQueueTime(req.get("X-Request-Start"))
  next()
}

module.exports = HireFireMiddlewareExpress
