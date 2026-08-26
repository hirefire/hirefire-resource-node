const { processRequestQueueTime } = require("../middleware")

/**
 * Fastify plugin that registers an `onRequest` hook to sample request queue time from the
 * `x-request-start` (or `x-queue-start`) header. Register it with `fastify.register(...)`.
 *
 * When a token is present, records a queue-time sample under the process HTTP name, marks
 * HTTP active, and starts the dispatcher (and job-queue loop when lease race entry is true).
 * Explicit http registration is optional. Failures are logged and swallowed so the host app
 * is unaffected.
 *
 * @param {*} fastify - The Fastify instance.
 * @param {*} options - Plugin options (unused).
 * @returns {Promise<void>}
 */
async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request, reply) => {
    processRequestQueueTime(
      () => request.headers["x-request-start"],
      () => request.headers["x-queue-start"],
    )
  })
}

HireFireMiddlewareFastify[Symbol.for("skip-override")] = true

module.exports = HireFireMiddlewareFastify
