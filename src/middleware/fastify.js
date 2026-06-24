const { processRequestQueueTime } = require("../middleware")

/**
 * Fastify plugin that registers an `onRequest` hook to sample request queue time from the
 * `x-request-start` (or `x-queue-start`) header. Register it with `fastify.register(...)`.
 *
 * @param {*} fastify - The Fastify instance.
 * @param {*} options - Plugin options (unused).
 * @returns {Promise<void>}
 */
async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request, reply) => {
    processRequestQueueTime(
      request.headers["x-request-start"] || request.headers["x-queue-start"],
    )
  })
}

HireFireMiddlewareFastify[Symbol.for("skip-override")] = true

module.exports = HireFireMiddlewareFastify
