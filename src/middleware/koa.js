const middleware = require('../middleware')

/**
 * Middleware function to process incoming requests. Analyzes the request queue time, if present,
 * and then determines whether to respond with queue metrics or pass the request along the stack.
 *
 * @param {Object} ctx - The Koa context object.
 * @param {Function} next - The next middleware function in the stack.
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
