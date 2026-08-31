const { processRequestQueueTime } = require("../middleware")

function readRequestStart(nextRequest) {
  return processRequestQueueTime(
    () => nextRequest.headers.get("X-Request-Start"),
    () => nextRequest.headers.get("X-Queue-Start"),
  )
}

function middleware(nextRequest) {
  const { NextResponse } = require("next/server")
  readRequestStart(nextRequest)
  return NextResponse.next()
}

function withHireFire(userMiddleware) {
  return function wrappedMiddleware(nextRequest, event) {
    readRequestStart(nextRequest)
    return userMiddleware(nextRequest, event)
  }
}

module.exports = { middleware, withHireFire }
