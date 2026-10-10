const { RQT, rqt } = require("../strategy")

const RQT_BACKFILL_LIMIT = 60
const METRIC_VALUE_LIMIT = 1e15
const EMPTY_BUCKET = Object.freeze({ sum: 0, count: 0 })

function build(data, { liveness, since, trace }, omitted) {
  const series = new Map()
  let watermark = null

  if (liveness) {
    const claimed = claim(data[liveness]?.[RQT], since)
    series.set(liveness, { [RQT]: claimed })
    watermark = Math.max(...Object.keys(claimed).map(Number))
  }

  for (const [name, strategies] of Object.entries(data)) {
    if (!series.has(name)) series.set(name, {})
    for (const [strategy, buckets] of Object.entries(strategies)) {
      series.get(name)[strategy] ??= buckets
    }
  }

  const entries = []
  for (const [name, strategies] of series) {
    const metrics = {}
    for (const [strategy, buckets] of Object.entries(strategies)) {
      const leaves = encode(name, strategy, buckets, omitted)
      if (Object.keys(leaves).length > 0) metrics[strategy] = leaves
    }
    if (Object.keys(metrics).length > 0) entries.push({ name, metrics })
  }

  if (trace && entries.length > 0) entries[0].sample_trace = trace
  return { entries, watermark }
}

function traced(entries) {
  return Object.hasOwn(entries[0], "sample_trace")
}

function withoutTrace(entries) {
  const { sample_trace: _trace, ...first } = entries[0]
  return [first, ...entries.slice(1)]
}

function claim(buckets, since) {
  const now = Math.floor(Date.now() / 1000)
  const next = since == null ? now : since + 1
  const from = Math.min(Math.max(next, now - RQT_BACKFILL_LIMIT), now)
  const claimed = { ...buckets }
  for (let second = from; second <= now; second++) {
    claimed[second] ??= EMPTY_BUCKET
  }
  return claimed
}

function encode(name, strategy, buckets, omitted) {
  const leaves = {}
  for (const [second, bucket] of Object.entries(buckets)) {
    const leaf = rqt(strategy) ? rqtLeaf(bucket) : valueLeaf(bucket)
    if (leaf === null) omitted(name, strategy)
    else leaves[second] = leaf
  }
  return leaves
}

function rqtLeaf({ sum, count }) {
  if (count === 0) return []

  const mean = valueLeaf(sum / count)
  return mean === null ? null : [mean, count]
}

function valueLeaf(value) {
  return value >= 0 && value <= METRIC_VALUE_LIMIT ? value : null
}

module.exports = {
  RQT_BACKFILL_LIMIT,
  METRIC_VALUE_LIMIT,
  build,
  traced,
  withoutTrace,
}
