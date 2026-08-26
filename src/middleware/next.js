const { processRequestQueueTime } = require("../middleware")

function readRequestStart(nextRequest) {
  return processRequestQueueTime(
    () => nextRequest.headers.get("X-Request-Start"),
    () => nextRequest.headers.get("X-Queue-Start"),
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
 * When a token is present, records a queue-time sample under the process HTTP name, marks
 * HTTP active, and starts the dispatcher (and job-queue loop when lease race entry is true).
 * Explicit http registration is optional. Failures are logged and swallowed so the host app
 * is unaffected.
 *
 * @param {*} nextRequest - The Next.js request.
 * @returns {*} A `NextResponse` that continues the chain.
 */
function middleware(nextRequest) {
  const { NextResponse } = require("next/server")
  readRequestStart(nextRequest)
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
    readRequestStart(nextRequest)
    return userMiddleware(nextRequest, event)
  }
}

module.exports = { middleware, withHireFire }
