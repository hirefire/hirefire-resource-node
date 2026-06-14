const { processRequestQueueTime } = require("../middleware")

function middleware(nextRequest) {
  const { NextResponse } = require("next/server")
  processRequestQueueTime(nextRequest.headers.get("X-Request-Start"))
  return NextResponse.next()
}

function withHireFire(userMiddleware) {
  return function wrappedMiddleware(nextRequest, event) {
    processRequestQueueTime(nextRequest.headers.get("X-Request-Start"))
    return userMiddleware(nextRequest, event)
  }
}

module.exports = { middleware, withHireFire }
