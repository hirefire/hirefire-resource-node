const { rqt } = require("./strategy")

const EMPTY_BUCKET = Object.freeze({ sum: 0, count: 0 })

class MetricsBuffer {
  static SAMPLE_COUNT_LIMIT = 1_000_000

  constructor(ttl = 60) {
    this._metrics = Object.create(null)
    this._ttl = ttl
  }

  sample(name, strategy, value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return

    const timestamp = Math.floor(Date.now() / 1000)
    const series = this._seriesFor(name, strategy)
    prune(series, timestamp, this._ttl)
    if (rqt(strategy)) {
      let bucket = series[timestamp]
      if (!bucket) {
        bucket = { sum: 0, count: 0 }
        series[timestamp] = bucket
      }
      if (bucket.count >= MetricsBuffer.SAMPLE_COUNT_LIMIT) return
      bucket.sum += value
      bucket.count += 1
    } else {
      series[timestamp] = value
    }
  }

  flush() {
    const metrics = this._metrics
    this._metrics = Object.create(null)
    return metrics
  }

  discard() {
    this._metrics = Object.create(null)
  }

  repopulate(name, strategy, data) {
    if (!rqt(strategy)) return

    const now = Math.floor(Date.now() / 1000)
    const series = this._seriesFor(name, strategy)
    for (const [second, { sum, count }] of Object.entries(data)) {
      if (Number(second) < now - this._ttl) continue

      const existing = series[second] ?? EMPTY_BUCKET
      series[second] = clampRqt(existing.sum + sum, existing.count + count)
    }
  }

  _seriesFor(name, strategy) {
    if (!this._metrics[name]) this._metrics[name] = Object.create(null)
    if (!this._metrics[name][strategy])
      this._metrics[name][strategy] = Object.create(null)
    return this._metrics[name][strategy]
  }
}

function clampRqt(sum, count) {
  if (count > MetricsBuffer.SAMPLE_COUNT_LIMIT) {
    const mean = sum / count
    return {
      sum: mean * MetricsBuffer.SAMPLE_COUNT_LIMIT,
      count: MetricsBuffer.SAMPLE_COUNT_LIMIT,
    }
  }
  return { sum, count }
}

function prune(buckets, now, ttl) {
  const seconds = Object.keys(buckets)
  if (seconds.length <= ttl + 5) return

  for (const second of seconds) {
    if (Number(second) < now - ttl) delete buckets[second]
  }
}

module.exports = MetricsBuffer
