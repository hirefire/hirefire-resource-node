class Buffer {
  constructor(ttl = 60) {
    this._web = {}
    this._workers = new Map()
    this._cpu = Object.create(null)
    this._ttl = ttl
  }

  sampleWeb(sample) {
    const timestamp = Math.floor(Date.now() / 1000)
    prune(this._web, timestamp, this._ttl)
    this._web[timestamp] = this._web[timestamp] || []
    this._web[timestamp].push(sample)
  }

  sampleWorker(name, sample) {
    this._workers.set(name, sample)
  }

  sampleCpu(name, value) {
    const timestamp = Math.floor(Date.now() / 1000)
    this._cpu[name] = this._cpu[name] || {}
    prune(this._cpu[name], timestamp, this._ttl)
    this._cpu[name][timestamp] = this._cpu[name][timestamp] || []
    this._cpu[name][timestamp].push(value)
  }

  flush() {
    const web = this._web
    const workers = this._workers
    const cpu = this._cpu
    this._web = {}
    this._workers = new Map()
    this._cpu = Object.create(null)

    return {
      web,
      workers: Array.from(workers, ([name, sample]) => ({ name, sample })),
      cpu,
    }
  }

  repopulateWeb(data) {
    const now = Math.floor(Date.now() / 1000)
    Object.entries(data).forEach(([timestamp, samples]) => {
      if (parseInt(timestamp) < now - this._ttl) return
      const bucket = (this._web[timestamp] = this._web[timestamp] || [])
      for (const sample of samples) bucket.push(sample)
    })
  }
}

function prune(buckets, now, ttl) {
  const keys = Object.keys(buckets)
  if (keys.length <= ttl + 5) return

  const cutoff = now - ttl
  keys.forEach((timestamp) => {
    if (parseInt(timestamp) < cutoff) delete buckets[timestamp]
  })
}

module.exports = Buffer
