const { RequestInfo, request } = require('../middleware')

/**
 * Connect middleware for autoscaling Heroku web and worker dynos using HireFire.
 *
 * This middleware uses the `request` function from the `middleware` module to process incoming HTTP
 * requests.  It creates a `RequestInfo` instance with the request path and start time, which is
 * then used by the `request` function to determine the appropriate action.
 *
 * The middleware responds with job queue metrics for specific requests.  If the incoming request
 * does not meet the specific conditions, control is passed to the next middleware in the stack.
 *
 * @async
 * @param {http.IncomingMessage} req - The incoming HTTP request object.
 * @param {http.ServerResponse} res - The HTTP response object for sending responses to the client.
 * @param {Function} next - Callback to invoke the next middleware in the stack.
 * @see {@link middleware.request} - Refer to the `request` function in the middleware.js module for
 *                                   details on request processing.
 * @example
 * // Example usage of HireFireMiddlewareConnect in a Connect application
 * const connect = require('connect')
 * const HireFireMiddlewareConnect = require('path/to/hirefire-resource/middleware/connect')
 * const app = connect()
 * app.use(HireFireMiddlewareConnect)
 */
async function HireFireMiddlewareConnect (req, res, next) {
  const response = await request(
    new RequestInfo(
      req.url,
      req.headers['x-request-start']
    )
  )

  if (response) {
    res.writeHead(response.status, response.headers)
    res.end(JSON.stringify(response.body))
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareConnect
