const { processRequestQueueTime } = require("../middleware")

function readRequestStart(nextRequest) {
  return (
    nextRequest.headers.get("X-Request-Start") ||
    nextRequest.headers.get("X-Queue-Start")
  )
}

/**
 * @callback NextMiddleware
 * @param {*} request - The Next.js request.
 * @param {*} [event] - The Next.js fetch event.
 * @returns {*}
 */

/**
 * Next.js middleware that samples request queue time from the `X-Request-Start` (or
 * `X-Queue-Start`) header and continues the chain via `NextResponse.next()`. Use it as your
 * `middleware` export, or wrap an existing middleware with {@link withHireFire}.
 *
 * @param {*} nextRequest - The Next.js request.
 * @returns {*} A `NextResponse` that continues the chain.
 */
function middleware(nextRequest) {
  const { NextResponse } = require("next/server")
  processRequestQueueTime(readRequestStart(nextRequest))
  return NextResponse.next()
}

/**
 * Wraps a Next.js middleware so HireFire samples request queue time before delegating to it.
 *
 * @param {NextMiddleware} userMiddleware - The middleware to wrap.
 * @returns {NextMiddleware} The wrapped middleware.
 */
function withHireFire(userMiddleware) {
  return function wrappedMiddleware(nextRequest, event) {
    processRequestQueueTime(readRequestStart(nextRequest))
    return userMiddleware(nextRequest, event)
  }
}

module.exports = { middleware, withHireFire }
