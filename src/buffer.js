// Thread-safe storage for web, worker, and CPU metric samples.
//
// Node runs on a single-threaded event loop, so unlike the Ruby reference there
// is no Mutex: every method below is fully synchronous, with no await between a
// read and its write, so no other code can interleave mid-operation. The
// dispatcher's flush is therefore atomic — it swaps the buffers out in one
// synchronous step before any network I/O is awaited.
class Buffer {
  constructor(ttl = 60) {
    // _web is keyed by Unix second; _cpu by collector name then Unix second;
    // _workers is a Map (insertion order). _cpu has a null prototype so a
    // declared name like "__proto__" can't mutate the global Object.prototype.
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

  // Latest-wins per name: worker samples are point-in-time gauges, so when
  // dispatch is starved only the most recent value is worth delivering. This
  // also bounds the buffer at one entry per declared worker.
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
      // A loop, not push(...samples): the spread would RangeError on a very large
      // array, and this runs inside the dispatch catch which must not throw.
      for (const sample of samples) bucket.push(sample)
    })
  }
}

// Insert-side TTL: when dispatch is starved the timestamped buffers must not
// grow without bound. Seconds older than the TTL would be rejected by the
// server's staleness window anyway. The size guard keeps the common case a
// single comparison.
function prune(buckets, now, ttl) {
  const keys = Object.keys(buckets)
  if (keys.length <= ttl + 5) return

  const cutoff = now - ttl
  keys.forEach((timestamp) => {
    if (parseInt(timestamp) < cutoff) delete buckets[timestamp]
  })
}

module.exports = Buffer
