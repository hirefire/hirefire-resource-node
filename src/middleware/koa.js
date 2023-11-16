const { RequestInfo, request } = require('../middleware')

/**
 * Koa middleware for autoscaling Heroku web and worker dynos using HireFire.
 *
 * This middleware uses the `request` function from the `middleware` module to process incoming HTTP
 * requests.  It creates a `RequestInfo` instance with the request path and start time, which is
 * then used by the `request` function to determine the appropriate action.
 *
 * The middleware responds with job queue metrics for specific requests.  If the incoming request
 * does not meet the specific conditions, control is passed to the next middleware in the stack.
 *
 * @async
 * @param {Koa.Context} ctx - The Koa context object, representing the request and response.
 * @param {Function} next - Callback function to invoke the next middleware in the stack.
 * @see {@link middleware.request} - Refer to the `request` function in the middleware.js module for
 *                                   details on request processing.
 * @example
 * // Example usage of HireFireMiddlewareKoa in a Koa application
 * const Koa = require('koa')
 * const HireFireMiddlewareKoa = require('path/to/hirefire-resource/middleware/koa')
 * const app = new Koa()
 * app.use(HireFireMiddlewareKoa)
 */
async function HireFireMiddlewareKoa (ctx, next) {
  const response = await request(
    new RequestInfo(
      ctx.path,
      ctx.get('X-Request-Start')
    )
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
