const Usage = require("./cpu/usage")

// Samples this process's container-level CPU utilization on each dispatcher
// tick and buffers it as a 0-100 percentage of the dyno's available CPU.
class CPU {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
    this._lastUsage = null
    this._lastTime = null
  }

  get name() {
    return this._name
  }

  sample() {
    const time = Date.now() / 1000.0
    const usage = Usage.totalSeconds()

    const previousUsage = this._lastUsage
    const previousTime = this._lastTime
    this._lastUsage = usage
    this._lastTime = time

    // The first reading only seeds the baseline.
    if (usage === null || previousUsage === null) return null

    const wallDelta = time - previousTime
    const usageDelta = usage - previousUsage

    // A non-positive wall delta means the clock stepped backward; a negative
    // usage delta means the usage source changed between reads (e.g. a cgroup
    // file vanished). Either way, skip the second rather than fabricate a value.
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
