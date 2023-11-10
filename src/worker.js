/**
 * The Worker class is responsible for measuring job queue metrics for various worker libraries and
 * making these metrics available to HireFire's servers. It is initialized with a name and a fn of
 * code that defines the metric measuring logic.
 */
class Worker {
  /**
   * Initializes a new instance of the Worker class with a given name and a function for work. The
   * name should correspond to the worker dyno designation in the Procfile, such as 'worker' or
   * 'mailer'.  The provided function must return a number that represents either the job queue
   * latency or job queue size metric. This function is expected to contain either one of the
   * provided macros for common measurement tasks or custom logic tailored to the specific queue
   * metric being monitored.
   *
   * @param {string} name - The name of the worker, corresponding to the Procfile's dyno name.
   * @param {function} fn - A function that returns a number representing the queue metric.
   */
  constructor (name, fn) {
    this.name = name
    this.fn = fn
  }

  /**
   * Executes the function passed during initialization and returns its result. This result should
   * be a number representing the measured queue metric (latency or size) that will be made
   * available to HireFire's servers.
   *
   * @return {number} The queue metric result from the executed function.
   */
  async call () {
    return this.fn()
  }
}

module.exports = { Worker }
