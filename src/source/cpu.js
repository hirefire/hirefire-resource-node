const Usage = require("./cpu/usage")

/**
 * CPU utilization source for an always-on process identity name.
 */
class CPU {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
    this._lastUsage = null
    this._lastTime = null
    this._lastSource = null
  }

  /**
   * The process name this source reports under.
   * @returns {string}
   */
  get name() {
    return this._name
  }

  /**
   * Samples CPU utilization and buffers a percentage when a delta is available.
   *
   * The first sample only seeds a baseline. Later samples no-op when the usage source changes,
   * elapsed time is non-positive, usage went backwards, or available CPUs cannot be determined.
   * A successful sample is clamped to 0-100 and rounded to two decimal places.
   *
   * @returns {void}
   */
  sample() {
    const time = performance.now() / 1000.0
    const { seconds: usage, source } = Usage.reading()

    const previousUsage = this._lastUsage
    const previousTime = this._lastTime
    const previousSource = this._lastSource
    this._lastUsage = usage
    this._lastTime = time
    this._lastSource = source

    if (usage === null || previousUsage === null || source !== previousSource)
      return null

    const elapsedDelta = time - previousTime
    const usageDelta = usage - previousUsage

    if (elapsedDelta <= 0 || usageDelta < 0) return null

    const available = Usage.availableCpus()
    if (available === null || available <= 0) return null

    const coresUsed = usageDelta / elapsedDelta
    const percentage = clamp((coresUsed / available) * 100.0, 0.0, 100.0)

    this._configuration.buffer.sample(this._name, "cpu", round2(percentage))
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function round2(value) {
  return Math.round(value * 100) / 100
}

module.exports = CPU
