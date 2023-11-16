/**
 * The Worker class is designed for measuring job queue metrics of various worker libraries.
 * It is used to provide these metrics to HireFire's servers. The class requires both a name
 * (indicative of the worker dyno type in the Procfile) and a function defining the logic for
 * measuring the desired metric (like job queue latency or size) upon instantiation.
 */
class Worker {
  /**
   * Constructs a new Worker instance.
   * The `name` should align with the worker dyno designation in the Procfile, such as 'worker' or 'mailer'.
   * The `fn` is a function that calculates and returns a specific job queue metric, which can be based on
   * common measurement approaches using macros or custom logic.
   *
   * @param {string} name - The name of the worker, corresponding to the dyno name in the Procfile.
   * @param {function} fn - A function that calculates and returns a numeric value for the job queue metric.
   */
  constructor (name, fn) {
    this.name = name
    this.fn = fn
  }

  /**
   * Executes the metric calculation function provided during instantiation.
   * This method is asynchronous and returns a Promise that resolves with the calculated metric.
   * The metric must represent a quantifiable aspect of the job queue: either latency or size.
   *
   * @return {Promise<number>} A Promise resolving with the calculated queue metric as a number.
   */
  async call () {
    return this.fn()
  }
}

module.exports = { Worker }
