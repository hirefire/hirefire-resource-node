const { RequestInfo, request } = require("../middleware")

async function HireFireMiddlewareKoa(ctx, next) {
  const response = await request(
    new RequestInfo(
      ctx.path,
      ctx.get("X-Request-Start"),
      ctx.get("HireFire-Token"),
    ),
  )

  if (response) {
    ctx.status = response.status
    ctx.set(response.headers)
    ctx.body = response.body
  } else {
    await next()
  }
}

module.exports = HireFireMiddlewareKoa
