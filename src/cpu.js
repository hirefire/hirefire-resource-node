const Usage = require("./cpu/usage")

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
    // Measure the interval on the monotonic clock (performance.now, ms to s) so a
    // wall-clock step (e.g. NTP) cannot distort the utilization delta. The buffered
    // sample's bucket timestamp stays wall-clock.
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

    // elapsedDelta <= 0 is a backstop: the monotonic clock never steps back.
    if (elapsedDelta <= 0 || usageDelta < 0) return null

    const available = Usage.availableCpus()
    if (available === null || available <= 0) return null

    const coresUsed = usageDelta / elapsedDelta
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
