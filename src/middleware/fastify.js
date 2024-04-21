const fp = require("fastify-plugin")
const { RequestInfo, request } = require("../middleware")

async function HireFireMiddlewareFastify(fastify, options) {
  fastify.addHook("onRequest", async (request_, reply) => {
    const response = await request(
      new RequestInfo(
        request_.url,
        request_.headers["x-request-start"],
        request_.headers["hirefire-token"],
      ),
    )

    if (response) {
      reply
        .status(response.status)
        .headers(response.headers)
        .send(response.body)
    }
  })
}

module.exports = fp(HireFireMiddlewareFastify, {
  fastify: ">=3.x",
  name: "hirefire-middleware-fastify",
})
