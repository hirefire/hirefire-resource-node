const fs = require("fs")
const os = require("os")

// Best-effort reads of container CPU usage and the normalization divisor.
const Usage = {
  CGROUP_V2_USAGE: "/sys/fs/cgroup/cpu.stat",
  CGROUP_V1_USAGE: "/sys/fs/cgroup/cpuacct/cpuacct.usage",
  CGROUP_V2_QUOTA: "/sys/fs/cgroup/cpu.max",
  CGROUP_V1_QUOTA: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
  CGROUP_V1_PERIOD: "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
  CEDAR_MEMORY_LIMIT: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  PROC_DIR: "/proc",

  // No portable sysconf in Node; 100 is the universal USER_HZ default.
  CLOCK_TICKS: 100,

  // Cedar shared dynos expose no CPU limit; the memory limit fingerprints the
  // size, which implies the entitlement. Other sizes fall through.
  CEDAR_SHARED_ENTITLEMENTS: {
    536870912: 1.0, // 512 MB: eco / basic / standard-1x
    1073741824: 2.0, // 1 GB: standard-2x
  },

  // Cumulative whole-container CPU seconds, first available source wins.
  totalSeconds() {
    return this.reading().seconds
  },

  // Returns { seconds, source }; the source label lets the consumer reseed when
  // the answering source changes, since counters from different sources aren't
  // comparable and differencing across a switch would fabricate a spike.
  reading() {
    const sources = [
      ["cgroupV2", () => this.cgroupV2Seconds()],
      ["cgroupV1", () => this.cgroupV1Seconds()],
      ["proc", () => this.procNamespaceSeconds()],
      ["process", () => this.processSeconds()],
    ]
    for (const [source, read] of sources) {
      const seconds = read()
      if (seconds !== null) return { seconds, source }
    }
    return { seconds: null, source: null }
  },

  // Returns null, not NaN: NaN isn't nullish, so it would defeat the ?? source
  // chain and stick as a permanent baseline.
  cgroupV2Seconds() {
    const content = this.read(this.CGROUP_V2_USAGE)
    if (!content) return null

    const line = content.split("\n").find((l) => l.startsWith("usage_usec"))
    if (!line) return null

    const usec = parseInt(line.trim().split(/\s+/).pop())
    return Number.isFinite(usec) ? usec / 1000000.0 : null
  },

  cgroupV1Seconds() {
    const ns = parseFloat(this.read(this.CGROUP_V1_USAGE))
    return Number.isFinite(ns) ? ns / 1000000000.0 : null
  },

  // Heroku exposes no cpu cgroup; /proc is PID-namespaced to the dyno, so
  // summing every visible process gives whole-dyno CPU.
  procNamespaceSeconds() {
    const paths = this.procStatPaths()
    if (paths.length === 0) return null

    let ticks = 0
    let counted = false
    paths.forEach((path) => {
      const content = this.read(path)
      if (!content) return
      const t = this.statTicks(content)
      if (t === null) return
      ticks += t
      counted = true
    })

    return counted ? ticks / this.CLOCK_TICKS : null
  },

  procStatPaths() {
    let entries
    try {
      entries = fs.readdirSync(this.PROC_DIR)
    } catch {
      return []
    }
    return entries
      .filter((entry) => /^[0-9]+$/.test(entry))
      .map((entry) => `${this.PROC_DIR}/${entry}/stat`)
  },

  // utime + stime ticks; parse after the last ")" since comm may contain spaces
  // and parens, which puts utime at index 11 and stime at index 12.
  statTicks(content) {
    const close = content.lastIndexOf(")")
    if (close === -1) return null

    const fields = content
      .slice(close + 1)
      .trim()
      .split(/\s+/)
    if (fields.length < 13) return null

    const utime = parseInt(fields[11])
    const stime = parseInt(fields[12])
    // Non-numeric fields return null so a bad PID is skipped, not summed as NaN.
    return Number.isFinite(utime) && Number.isFinite(stime)
      ? utime + stime
      : null
  },

  // Wrapped so a clock failure yields null, honoring the finite-or-null contract.
  processSeconds() {
    try {
      const { user, system } = process.cpuUsage()
      return (user + system) / 1000000.0
    } catch {
      return null
    }
  },

  // CPUs to normalize against: the platform's guarantee, not the host core
  // count. First source wins.
  availableCpus() {
    return (
      this.cgroupV2Quota() ??
      this.cgroupV1Quota() ??
      this.herokuEntitlement() ??
      this.processorCount()
    )
  },

  cgroupV2Quota() {
    const value = this.read(this.CGROUP_V2_QUOTA)
    if (!value) return null

    const [quota, period] = value.split(/\s+/)
    if (quota === undefined || quota === "max") return null

    const quotaValue = parseFloat(quota)
    const periodValue = parseFloat(period)
    // > 0 rejects NaN, zero, and negatives, so a malformed quota falls through
    // instead of dividing (matches cgroupV1Quota).
    return quotaValue > 0 && periodValue > 0 ? quotaValue / periodValue : null
  },

  cgroupV1Quota() {
    const quota = parseInt(this.read(this.CGROUP_V1_QUOTA))
    const period = parseFloat(this.read(this.CGROUP_V1_PERIOD))
    // x > 0 rejects unreadable (NaN), zero, and the v1 "-1" unlimited marker, so
    // a malformed value falls through instead of dividing (matches cgroupV2Quota).
    return quota > 0 && period > 0 ? quota / period : null
  },

  // Gated on DYNO: a v1 memory limit says nothing about CPU off Heroku.
  herokuEntitlement() {
    if (!process.env.DYNO) return null

    const limit = this.read(this.CEDAR_MEMORY_LIMIT)
    if (!limit) return null

    return this.CEDAR_SHARED_ENTITLEMENTS[parseInt(limit)] ?? null
  },

  processorCount() {
    try {
      if (typeof os.availableParallelism === "function") {
        return os.availableParallelism()
      }
      const count = os.cpus().length
      return count > 0 ? count : 1
    } catch {
      return 1 // a sane divisor if the OS query fails; availableCpus stays positive
    }
  },

  read(path) {
    try {
      return fs.readFileSync(path, "utf8").trim()
    } catch {
      return null
    }
  },
}

module.exports = Usage
