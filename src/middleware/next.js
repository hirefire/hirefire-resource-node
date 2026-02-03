const { RequestInfo, request } = require("../middleware")

async function middleware(nextRequest) {
  const { NextResponse } = require("next/server")

  const response = await request(
    new RequestInfo(
      nextRequest.nextUrl.pathname,
      nextRequest.headers.get("X-Request-Start"),
      nextRequest.headers.get("HireFire-Token"),
    ),
  )

  if (response) {
    return NextResponse.json(response.body, {
      status: response.status,
      headers: response.headers,
    })
  }

  return NextResponse.next()
}

function withHireFire(userMiddleware) {
  return async function wrappedMiddleware(nextRequest, event) {
    const { NextResponse } = require("next/server")

    const response = await request(
      new RequestInfo(
        nextRequest.nextUrl.pathname,
        nextRequest.headers.get("X-Request-Start"),
        nextRequest.headers.get("HireFire-Token"),
      ),
    )

    if (response) {
      return NextResponse.json(response.body, {
        status: response.status,
        headers: response.headers,
      })
    }

    return userMiddleware(nextRequest, event)
  }
}

module.exports = { middleware, withHireFire }
