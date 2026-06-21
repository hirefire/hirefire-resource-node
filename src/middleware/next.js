const { processRequestQueueTime } = require("../middleware")

function readRequestStart(nextRequest) {
  return (
    nextRequest.headers.get("X-Request-Start") ||
    nextRequest.headers.get("X-Queue-Start")
  )
}

function middleware(nextRequest) {
  const { NextResponse } = require("next/server")
  processRequestQueueTime(readRequestStart(nextRequest))
  return NextResponse.next()
}

function withHireFire(userMiddleware) {
  return function wrappedMiddleware(nextRequest, event) {
    processRequestQueueTime(readRequestStart(nextRequest))
    return userMiddleware(nextRequest, event)
  }
}

module.exports = { middleware, withHireFire }
