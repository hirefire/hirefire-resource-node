const { processRequestQueueTime } = require("../middleware")

/**
 * Koa middleware that samples request queue time from the `X-Request-Start` (or `X-Queue-Start`)
 * header, then awaits the rest of the chain. Mount it with `app.use(...)`.
 *
 * When a token is present, records a queue-time sample under the process HTTP name, marks
 * HTTP active, and starts the dispatcher (and job-queue loop when lease race entry is true).
 * Explicit http registration is optional. Failures are logged and swallowed so the host app
 * is unaffected.
 *
 * @param {*} ctx - The Koa context.
 * @param {() => Promise<void>} next - Awaits the downstream middleware.
 * @returns {Promise<void>}
 */
async function HireFireMiddlewareKoa(ctx, next) {
  processRequestQueueTime(ctx.get("X-Request-Start"), ctx.get("X-Queue-Start"))
  await next()
}

module.exports = HireFireMiddlewareKoa
