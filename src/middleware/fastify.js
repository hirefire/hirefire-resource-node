const fp = require("fastify-plugin")
const { processRequestQueueTime } = require("../middleware")

async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request, reply) => {
    processRequestQueueTime(request.headers["x-request-start"])
  })
}

module.exports = fp(HireFireMiddlewareFastify, {
  fastify: ">=3.x",
  name: "hirefire-middleware-fastify",
})
