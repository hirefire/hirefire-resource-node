const { rqt } = require("./strategy")

class Buffer {
  static SAMPLE_COUNT_LIMIT = 1_000_000

  constructor(ttl = 60) {
    this._metrics = Object.create(null)
    this._ttl = ttl
  }

  sample(name, strategy, value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return

    const timestamp = Math.floor(Date.now() / 1000)
    strategy = String(strategy)
    const series = this._seriesFor(name, strategy)
    prune(series, timestamp, this._ttl)
    if (rqt(strategy)) {
      let bucket = series[timestamp]
      if (!bucket) {
        bucket = { sum: 0, count: 0 }
        series[timestamp] = bucket
      }
      if (bucket.count >= Buffer.SAMPLE_COUNT_LIMIT) return
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

  discardInherited() {
    this._metrics = Object.create(null)
  }

  repopulate(name, strategy, data) {
    strategy = String(strategy)
    if (!rqt(strategy)) return

    const now = Math.floor(Date.now() / 1000)
    let series = null
    for (const [timestampKey, bucket] of Object.entries(data)) {
      const timestamp = parseInt(timestampKey, 10)
      if (timestamp < now - this._ttl) continue
      const { sum, count } = rqtParts(bucket)
      if (count <= 0) continue
      if (!series) series = this._seriesFor(name, strategy)
      const existing = series[timestamp]
      if (
        existing &&
        typeof existing === "object" &&
        !Array.isArray(existing)
      ) {
        series[timestamp] = clampRqt(existing.sum + sum, existing.count + count)
      } else {
        series[timestamp] = clampRqt(sum, count)
      }
    }
    if (series) prune(series, now, this._ttl)
  }

  _seriesFor(name, strategy) {
    if (!this._metrics[name]) this._metrics[name] = Object.create(null)
    if (!this._metrics[name][strategy])
      this._metrics[name][strategy] = Object.create(null)
    return this._metrics[name][strategy]
  }
}

function clampRqt(sum, count) {
  if (count > Buffer.SAMPLE_COUNT_LIMIT) {
    const mean = sum / count
    return {
      sum: mean * Buffer.SAMPLE_COUNT_LIMIT,
      count: Buffer.SAMPLE_COUNT_LIMIT,
    }
  }
  return { sum, count }
}

function rqtParts(bucket) {
  if (bucket && typeof bucket === "object" && !Array.isArray(bucket)) {
    const sum =
      bucket.sum === undefined || bucket.sum === null ? 0 : Number(bucket.sum)
    const countRaw =
      bucket.count === undefined || bucket.count === null
        ? 0
        : Math.trunc(Number(bucket.count))
    return {
      sum,
      count: Number.isFinite(countRaw) ? countRaw : 0,
    }
  }
  return { sum: 0, count: 0 }
}

function prune(buckets, now, ttl) {
  const keys = Object.keys(buckets)
  if (keys.length <= ttl + 5) return

  const cutoff = now - ttl
  keys.forEach((timestamp) => {
    if (parseInt(timestamp, 10) < cutoff) delete buckets[timestamp]
  })
}

module.exports = Buffer
module.exports.rqtParts = rqtParts
