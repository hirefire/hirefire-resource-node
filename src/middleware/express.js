const middleware = require('../middleware')

/**
 * Express middleware for autoscaling Heroku web and worker dynos using HireFire.
 *
 * This middleware delegates request processing to the `request` function in the `middleware`
 * module. It handles incoming HTTP requests by analyzing the request path and start time.
 *
 * The middleware checks for specific conditions (like request path) and, if met, responds with the
 * necessary job queue metrics. If the conditions are not met, it passes control to the next
 * middleware in the stack.
 *
 * @param {express.Request} req - The Express request object.
 * @param {express.Response} res - The Express response object to send responses to the client.
 * @param {Function} next - Callback to invoke the next middleware function in the stack.
 * @see {@link middleware.request} - See the `request` function in the middleware.js module for detail on request processing.
 * @example
 * // Example of how to use HireFireMiddlewareExpress in an Express app
 * const express = require('express')
 * const HireFireMiddlewareExpress = require('hirefire-resource/middleware/express')
 * const app = express()
 * app.use(HireFireMiddlewareExpress)
 */
async function HireFireMiddlewareExpress (req, res, next) {
  const response = await middleware.request({
    path: req.path,
    requestStartTime: req.get('X-Request-Start')
  })

  if (response) {
    res.status(response.status).set(response.headers).json(response.body)
  } else {
    next()
  }
}

module.exports = HireFireMiddlewareExpress
