const { RequestInfo, request } = require('../middleware')

/**
 * Express middleware for autoscaling Heroku web and worker dynos using HireFire.
 *
 * This middleware uses the `request` function from the `middleware` module to process incoming HTTP
 * requests.  It creates a `RequestInfo` instance with the request path and start time, which is
 * then used by the `request` function to determine the appropriate action.
 *
 * The middleware responds with job queue metrics for specific requests.  If the incoming request
 * does not meet the specific conditions, control is passed to the next middleware in the stack.
 *
 * @async
 * @param {express.Request} req - The Express request object, containing request details.
 * @param {express.Response} res - The Express response object for sending responses to the client.
 * @param {Function} next - Callback function to invoke the next middleware in the stack.
 * @see {@link middleware.request} - Refer to the `request` function in the middleware.js module for
 *                                   details on request processing.
 * @example
 * // Example usage of HireFireMiddlewareExpress in an Express application
 * const express = require('express')
 * const HireFireMiddlewareExpress = require('path/to/hirefire-resource/middleware/express')
 * const app = express()
 * app.use(HireFireMiddlewareExpress)
 */
async function HireFireMiddlewareExpress (req, res, next) {
  const response = await request(
    new RequestInfo(
      req.path,
      req.get('X-Request-Start')
    )
  )

  if (response) {
    res
      .status(response.status)
      .set(response.headers)
      .json(response.body)
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareExpress
