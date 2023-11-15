const middleware = require('../middleware')

/**
 * Connect middleware for autoscaling Heroku web and worker dynos using HireFire.
 *
 * This middleware delegates request processing to the `request` function in the `middleware`
 * module. It handles incoming HTTP requests by analyzing the request path and start time.
 *
 * The middleware checks for specific conditions (like request path) and, if met, responds with the
 * necessary job queue metrics. If the conditions are not met, it passes control to the next
 * middleware in the stack.
 *
 * @param {http.IncomingMessage} req - The incoming HTTP request object.
 * @param {http.ServerResponse} res - The HTTP response object to send responses to the client.
 * @param {Function} next - Callback to invoke the next middleware in the stack.
 * @see {@link middleware.request} - See the `request` function in the middleware.js module for detail on request processing.
 * @example
 * // Example of how to use HireFireMiddlewareConnect in a Connect app
 * const connect = require('connect')
 * const HireFireMiddlewareConnect = require('hirefire-resource/middleware/connect')
 * const app = connect()
 * app.use(HireFireMiddlewareConnect)
 */
async function HireFireMiddlewareConnect (req, res, next) {
  const response = await middleware.request({
    path: req.url,
    requestStartTime: req.headers['x-request-start']
  })

  if (response) {
    res.writeHead(response.status, response.headers)
    res.end(JSON.stringify(response.body))
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareConnect
