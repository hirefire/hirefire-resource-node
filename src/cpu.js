const Usage = require("./cpu/usage")

// Samples this process's CPU utilization as a 0-100% of available CPU.
class CPU {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
    this._lastUsage = null
    this._lastTime = null
    this._lastSource = null
  }

  get name() {
    return this._name
  }

  sample() {
    const time = Date.now() / 1000.0
    const { seconds: usage, source } = Usage.reading()

    const previousUsage = this._lastUsage
    const previousTime = this._lastTime
    const previousSource = this._lastSource
    this._lastUsage = usage
    this._lastTime = time
    this._lastSource = source

    // The first reading only seeds the baseline; so does a usage-source change
    // (a delta across a switch would fabricate a spike).
    if (usage === null || previousUsage === null || source !== previousSource)
      return null

    const wallDelta = time - previousTime
    const usageDelta = usage - previousUsage

    // Skip rather than fabricate: the clock stepped back, or the usage counter
    // went backward.
    if (wallDelta <= 0 || usageDelta < 0) return null

    const available = Usage.availableCpus()
    if (available === null || available <= 0) return null

    const coresUsed = usageDelta / wallDelta
    const percentage = clamp((coresUsed / available) * 100.0, 0.0, 100.0)

    this._configuration.buffer.sampleCpu(this._name, round2(percentage))
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function round2(value) {
  return Math.round(value * 100) / 100
}

module.exports = CPU
