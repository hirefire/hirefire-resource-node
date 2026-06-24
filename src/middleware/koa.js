const { processRequestQueueTime } = require("../middleware")

/**
 * Koa middleware that samples request queue time from the `X-Request-Start` (or `X-Queue-Start`)
 * header, then awaits the rest of the chain. Mount it with `app.use(...)`.
 *
 * @param {*} ctx - The Koa context.
 * @param {() => Promise<void>} next - Awaits the downstream middleware.
 * @returns {Promise<void>}
 */
async function HireFireMiddlewareKoa(ctx, next) {
  processRequestQueueTime(
    ctx.get("X-Request-Start") || ctx.get("X-Queue-Start"),
  )
  await next()
}

module.exports = HireFireMiddlewareKoa
