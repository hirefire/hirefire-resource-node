const middleware = require('../middleware')

/**
 * HireFireMiddleware provides a Connect middleware for capturing and providing metrics required
 * for autoscaling Heroku web and worker dynos. It serves two primary roles:
 *
 * 1. It responds to specific HTTP requests with JSON-formatted queue metrics.
 * 2. It captures and processes request queue time data from incoming HTTP requests, forwarding it
 *    to `Web` for further handling or logging it for HireFire Logdrain capture, depending on
 *    configuration.
 *
 * The middleware intercepts requests to the HireFire info endpoints and allows all other requests
 * to pass through unaffected. The `X-Request-Start` header, set by the Heroku router, provides the
 * data for measuring request queue times.
 *
 * Middleware function to process incoming requests. Analyzes the request queue time, if present,
 * and then determines whether to respond with queue metrics or pass the request along the stack.
 *
 * @param {http.IncomingMessage} req - The HTTP request object.
 * @param {http.ServerResponse} res - The HTTP response object.
 * @param {Function} next - The next middleware function in the stack.
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
