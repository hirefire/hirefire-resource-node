const { processRequestQueueTime } = require("../middleware")

// Fastify scopes a registered plugin's hooks to its own encapsulation context;
// skip-override lifts that scope so the onRequest hook covers the whole app.
// That is the only thing fastify-plugin did for us, inlined so this adapter —
// like every other one — depends solely on the user's own framework, with no
// third-party helper to install.
async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request, reply) => {
    processRequestQueueTime(request.headers["x-request-start"])
  })
}

HireFireMiddlewareFastify[Symbol.for("skip-override")] = true

module.exports = HireFireMiddlewareFastify
