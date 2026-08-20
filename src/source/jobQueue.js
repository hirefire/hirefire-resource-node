/**
 * Job-queue source: one declared local sampler for a process name (feeds `jql` / `jqs`).
 *
 * Samples a job backend queue (depth or oldest age), not an individual job.
 */
class JobQueue {
  constructor(name, sampler) {
    this._name = String(name)
    this._sampler = sampler
  }

  /**
   * The process name this source reports under.
   * @returns {string}
   */
  get name() {
    return this._name
  }

  /**
   * Returns the current job-queue metric value from the configured sampler.
   *
   * @returns {Promise<number>}
   */
  async sample() {
    return this._sampler()
  }
}

module.exports = JobQueue
