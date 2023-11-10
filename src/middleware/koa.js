const Resource = require('../Resource')

/**
 * HireFireMiddleware provides a Koa middleware for capturing and providing metrics required
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
 */
class HireFireMiddlewareKoa {
  constructor () {
    this.handle = this.handle.bind(this)
  }

  /**
   * Middleware function to process incoming requests. Analyzes the request queue time, if present,
   * and then determines whether to respond with queue metrics or pass the request along the stack.
   *
   * @param {Object} ctx - The Koa context object.
   * @param {Function} next - The next middleware function in the stack.
   */
  async handle (ctx, next) {
    this.processRequestQueueTime(ctx)

    if (this.matchesInfoPath(ctx)) {
      const infoResponse = this.constructInfoResponse()
      ctx.status = 200
      ctx.body = infoResponse
    } else {
      await next()
    }
  }

  /**
   * Determines if the given request path aligns with the info path.
   * @param {Object} ctx - The Koa context object.
   * @return {boolean} True if paths align, otherwise false.
   */
  matchesInfoPath (ctx) {
    const token = process.env.HIREFIRE_TOKEN || 'development'
    return ctx.path === `/hirefire/${token}/info`
  }

  /**
   * Creates the HTTP response for the info path, containing worker
   * queue metrics based on `Resource.configuration.workers` configuration.
   * @return {Object[]} An array of worker metrics.
   */
  constructInfoResponse () {
    return Resource.configuration.workers.map((worker) => ({
      name: worker.name,
      value: worker.fn()
    }))
  }

  /**
   * Analyzes the request queue time based on the `X-Request-Start` header
   * and performs actions based on the configuration settings in `Resource.configuration`.
   * @param {Object} ctx - The Koa context object.
   */
  processRequestQueueTime (ctx) {
    const requestStartTime = ctx.get('X-Request-Start')
    if (requestStartTime && Resource.configuration.web) {
      const requestQueueTime = this.calculateRequestQueueTime(requestStartTime)
      Resource.configuration.web.start()
      Resource.configuration.web.addToBuffer(requestQueueTime)
    }
  }

  /**
   * Calculates the time gap (in milliseconds) between the given
   * `X-Request-Start` timestamp and the present time.
   * @param {string} timestamp - Timestamp from the `X-Request-Start` header.
   * @return {number} The computed queue time in milliseconds.
   */
  calculateRequestQueueTime (timestamp) {
    const ms = Date.now() - parseInt(timestamp, 10)
    return ms < 0 ? 0 : ms
  }
}

module.exports = HireFireMiddlewareKoa
