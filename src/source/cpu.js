const Usage = require("./cpu/usage")
const Strategy = require("../strategy")

class CPU {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
    this._last = { source: null }
  }

  get name() {
    return this._name
  }

  sample() {
    const time = performance.now() / 1000.0
    const { seconds: usage, source } = Usage.reading()

    const last = this._last
    this._last = { usage, time, source }

    if (usage === null || source !== last.source) return null

    const elapsedDelta = time - last.time
    const usageDelta = usage - last.usage

    if (elapsedDelta <= 0 || usageDelta < 0) return null

    const available = Usage.availableCpus()
    if (available === null || available <= 0) return null

    const coresUsed = usageDelta / elapsedDelta
    const percentage = clamp((coresUsed / available) * 100.0, 0.0, 100.0)

    this._configuration.buffer.sample(
      this._name,
      Strategy.CPU,
      round2(percentage),
    )
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

function round2(value) {
  return Math.round(value * 100) / 100
}

module.exports = CPU
