const { RequestInfo, request } = require("../middleware")

async function HireFireMiddlewareKoa(ctx, next) {
  const response = await request(
    new RequestInfo(ctx.path, ctx.get("X-Request-Start")),
  )

  if (response) {
    ctx.status = response.status
    ctx.set(response.headers)
    ctx.body = response.body
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareKoa
