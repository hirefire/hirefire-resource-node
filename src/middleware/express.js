const { RequestInfo, request } = require('../middleware')

/**
 * Express middleware for autoscaling Heroku web and worker dynos with HireFire.
 *
 * This middleware leverages the `request` function from the `middleware` module to process incoming
 * HTTP requests. It instantiates a `RequestInfo` object with the request path and start time, which
 * is then passed to the `request` function for determining the necessary action.
 *
 * The middleware is capable of responding with job queue metrics for specific requests. For other
 * requests, it passes control to the next middleware in the stack.
 *
 * @async
 * @param {express.Request} req - The Express request object, encapsulating request details.
 * @param {express.Response} res - The Express response object for sending responses to the client.
 * @param {Function} next - The callback function to invoke the next middleware in the stack.
 * @see {@link middleware.request} - For detailed logic on request processing.
 * @example
 * // Example usage of HireFireMiddlewareExpress in an Express application
 * const express = require('express')
 * const HireFireMiddlewareExpress = require('hirefire-resource/middleware/express')
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
