const { RequestInfo, request } = require('../middleware')

/**
 * Connect middleware for autoscaling Heroku web and worker dynos with HireFire.
 *
 * This middleware leverages the `request` function from the `middleware` module to process incoming
 * HTTP requests. It instantiates a `RequestInfo` object with the request path and start time, which
 * is then passed to the `request` function for determining the necessary action.
 *
 * The middleware is capable of responding with job queue metrics for specific requests. For other
 * requests, it passes control to the next middleware in the stack.
 *
 * @async
 * @param {http.IncomingMessage} req - The incoming HTTP request object.
 * @param {http.ServerResponse} res - The HTTP response object for sending responses to the client.
 * @param {Function} next - The callback function to invoke the next middleware in the stack.
 * @see {@link middleware.request} - For details on the request processing logic.
 * @example
 * // Example usage of HireFireMiddlewareConnect in a Connect application
 * const connect = require('connect')
 * const HireFireMiddlewareConnect = require('hirefire-resource/middleware/connect')
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
