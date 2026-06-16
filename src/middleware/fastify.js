const { processRequestQueueTime } = require("../middleware")

// Fastify scopes a plugin's hooks to its own encapsulation context;
// skip-override lifts that so the onRequest hook covers the whole app.
async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request, reply) => {
    processRequestQueueTime(request.headers["x-request-start"])
  })
}

HireFireMiddlewareFastify[Symbol.for("skip-override")] = true

module.exports = HireFireMiddlewareFastify
