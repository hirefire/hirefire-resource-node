const { RequestInfo, request } = require("../middleware")

async function HireFireMiddlewareExpress(req, res, next) {
  const response = await request(
    new RequestInfo(
      req.path,
      req.get("X-Request-Start"),
      req.get("HireFire-Token"),
    ),
  )

  if (response) {
    res.status(response.status).set(response.headers).json(response.body)
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareExpress
