const { processRequestQueueTime } = require("../middleware")

async function HireFireMiddlewareKoa(ctx, next) {
  processRequestQueueTime(ctx.get("X-Request-Start"))
  await next()
}

module.exports = HireFireMiddlewareKoa
