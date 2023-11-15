/**
 * The Worker class measures job queue metrics for various worker libraries and provides these
 * metrics to HireFire's servers. It requires a name and a function defining the metric measuring
 * logic upon initialization.
 */
class Worker {
  /**
   * Creates a new Worker instance. The `name` parameter should match the worker dyno designation in
   * the Procfile, like 'worker' or 'mailer'. The `fn` parameter should be a function that
   * calculates and returns a queue metric (such as job queue latency or size). This function can
   * include common measurement macros or custom logic tailored to the specific metric.
   *
   * @param {string} name - The name of the worker, corresponding to the dyno name in the Procfile.
   * @param {function} fn - A function that calculates and returns a numeric queue metric.
   */
  constructor (name, fn) {
    this.name = name
    this.fn = fn
  }

  /**
   * Executes the metric calculation function provided at initialization. This method is
   * asynchronous and returns a Promise that resolves to the calculated metric, typically a number
   * representing queue latency or size.
   *
   * @return {Promise<number>} A Promise that resolves to the calculated queue metric.
   */
  async call () {
    return this.fn()
  }
}

module.exports = { Worker }
