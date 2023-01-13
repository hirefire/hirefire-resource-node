const { RequestInfo, request } = require("../middleware")

async function HireFireMiddlewareConnect(req, res, next) {
  const response = await request(
    new RequestInfo(
      req.url,
      req.headers["x-request-start"],
      req.headers["hirefire-token"],
    ),
  )

  if (response) {
    res.writeHead(response.status, response.headers)
    res.end(JSON.stringify(response.body))
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareConnect
