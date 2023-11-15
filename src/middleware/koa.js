const middleware = require('../middleware')

/**
 * Koa middleware for autoscaling Heroku web and worker dynos using HireFire.
 *
 * This middleware delegates request processing to the `request` function in the `middleware`
 * module. It analyzes the request path and start time, and, if necessary, generates a response with
 * job queue metrics.
 *
 * The middleware checks for specific conditions (like request path) and, if met, responds with the
 * necessary job queue metrics. If the conditions are not met, it passes control to the next
 * middleware in the stack.
 *
 * @param {Koa.Context} ctx - The Koa context object representing the request and response.
 * @param {Function} next - Callback to invoke the next middleware function in the stack.
 * @see {@link middleware.request} - See the `request` function in the middleware.js module for detail on request processing.
 * @example
 * // Example of how to use HireFireMiddlewareKoa in a Koa app
 * const Koa = require('koa')
 * const HireFireMiddlewareKoa = require('hirefire-resource/middleware/koa')
 * const app = new Koa()
 * app.use(HireFireMiddlewareKoa)
 */
async function HireFireMiddlewareKoa (ctx, next) {
  const response = await middleware.request({
    path: ctx.path,
    requestStartTime: ctx.get('X-Request-Start')
  })

  if (response) {
    ctx.status = response.status
    ctx.set(response.headers)
    ctx.body = response.body
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareKoa
