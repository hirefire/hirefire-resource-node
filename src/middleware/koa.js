const { processRequestQueueTime } = require("../middleware")

async function HireFireMiddlewareKoa(ctx, next) {
  // X-Queue-Start is an exact synonym for X-Request-Start (e.g. Render).
  processRequestQueueTime(
    ctx.get("X-Request-Start") || ctx.get("X-Queue-Start"),
  )
  await next()
}

module.exports = HireFireMiddlewareKoa
