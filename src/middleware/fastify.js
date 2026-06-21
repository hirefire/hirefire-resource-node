const { processRequestQueueTime } = require("../middleware")

async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request, reply) => {
    processRequestQueueTime(
      request.headers["x-request-start"] || request.headers["x-queue-start"],
    )
  })
}

HireFireMiddlewareFastify[Symbol.for("skip-override")] = true

module.exports = HireFireMiddlewareFastify
