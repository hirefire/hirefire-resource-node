const { RequestInfo, request } = require('../middleware')

/**
 * Koa middleware for autoscaling Heroku web and worker dynos with HireFire.
 *
 * This middleware leverages the `request` function from the `middleware` module to process incoming
 * HTTP requests. It instantiates a `RequestInfo` object with the request path and start time, which
 * is then passed to the `request` function for determining the necessary action.
 *
 * The middleware is capable of responding with job queue metrics for specific requests. For other
 * requests, it passes control to the next middleware in the stack.
 *
 * @async
 * @param {Koa.Context} ctx - The Koa context object, encapsulating the HTTP request and response.
 * @param {Function} next - The callback function to continue the middleware chain execution.
 * @see {@link middleware.request} - For detailed logic on request processing.
 * @example
 * // Example usage of HireFireMiddlewareKoa in a Koa application
 * const Koa = require('koa')
 * const HireFireMiddlewareKoa = require('hirefire-resource/middleware/koa')
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
