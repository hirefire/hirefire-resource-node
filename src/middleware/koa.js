const { processRequestQueueTime } = require("../middleware")

async function HireFireMiddlewareKoa(ctx, next) {
  processRequestQueueTime(
    () => ctx.get("X-Request-Start"),
    () => ctx.get("X-Queue-Start"),
  )
  await next()
}

module.exports = HireFireMiddlewareKoa
