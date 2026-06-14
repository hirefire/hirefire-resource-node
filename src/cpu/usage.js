const fs = require("fs")
const os = require("os")

// Reads container-level CPU usage and the CPU normalization divisor, trying
// progressively less precise sources. All reads are best-effort: a missing or
// unreadable file returns null so the caller can fall through.
const Usage = {
  CGROUP_V2_USAGE: "/sys/fs/cgroup/cpu.stat",
  CGROUP_V1_USAGE: "/sys/fs/cgroup/cpuacct/cpuacct.usage",
  CGROUP_V2_QUOTA: "/sys/fs/cgroup/cpu.max",
  CGROUP_V1_QUOTA: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
  CGROUP_V1_PERIOD: "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
  CEDAR_MEMORY_LIMIT: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  PROC_DIR: "/proc",

  // No portable sysconf in Node; 100 is the universal USER_HZ default and the
  // value the /proc/[pid]/stat parser needs on the Linux dynos where it runs.
  CLOCK_TICKS: 100,

  // Cedar shared dynos have no CPU limit anywhere, but each size is bound to a
  // fixed memory limit, so the memory limit identifies the size and the size
  // implies the CPU entitlement. Dedicated dynos are deliberately absent: their
  // core count is the real one, so they fall through.
  CEDAR_SHARED_ENTITLEMENTS: {
    536870912: 1.0, // 512 MB: eco / basic / standard-1x
    1073741824: 2.0, // 1 GB: standard-2x
  },

  // Cumulative CPU time in seconds for the whole dyno/container, from the first
  // available source: cgroup v2, cgroup v1, the /proc PID namespace, or this
  // process's own clock. Heroku exposes no cpu cgroup at all, so /proc carries
  // it there: it is PID-namespaced to the dyno, so summing every visible
  // process gives whole-dyno CPU — covering multi-process servers without a
  // shared counter. process.cpuUsage() is the dev/macOS last resort and only
  // sees this process.
  totalSeconds() {
    return this.reading().seconds
  },

  // { seconds, source } — the source label lets the consumer reseed when the
  // answering source changes between ticks (e.g. /proc briefly unreadable, then
  // back). Counters from different sources aren't comparable: a whole-dyno
  // source (cgroup/proc) and the per-process clock differ by orders of
  // magnitude, so differencing across a switch would fabricate a usage spike.
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

  // A malformed value returns null (not NaN) so totalSeconds keeps its
  // finite-or-null contract: NaN is not nullish, so it would defeat the ??
  // source chain and stick as a permanent CPU baseline. The line is trimmed
  // before splitting so a trailing space can't make pop() an empty token.
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

  // utime + stime (clock ticks) from a /proc/[pid]/stat line. The comm field
  // (2nd) can contain spaces and parens, so parse from after the last ')': the
  // remaining fields put utime at index 11 and stime at index 12.
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
    // Non-numeric fields return null so the per-process tick is skipped rather
    // than poisoning the whole-dyno sum with NaN.
    return Number.isFinite(utime) && Number.isFinite(stime)
      ? utime + stime
      : null
  },

  // Wrapped like the file's fs reads so reading() honors its finite-or-null
  // contract even if the clock read fails on an exotic platform.
  processSeconds() {
    try {
      const { user, system } = process.cpuUsage()
      return (user + system) / 1000000.0
    } catch {
      return null
    }
  },

  // Number of CPUs to normalize usage against — the CPU the platform guarantees
  // this container, not the host's core count. Sources, first answer wins: a
  // cgroup quota (platforms with a hard CPU limit), the Cedar shared-dyno
  // entitlement (shared dynos burst on an 8-core host, so the core count would
  // understate utilization and invert under contention), or the core count
  // (dedicated machines, where the host's core count is the container's).
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
    // !(x > 0) on both rejects NaN, zero, and negatives in one comparison, so a
    // malformed quota falls through to the next source instead of normalizing
    // CPU against a bad divisor (matches cgroupV1Quota).
    return quotaValue > 0 && periodValue > 0 ? quotaValue / periodValue : null
  },

  cgroupV1Quota() {
    const quota = parseInt(this.read(this.CGROUP_V1_QUOTA))
    const period = parseFloat(this.read(this.CGROUP_V1_PERIOD))
    // x > 0 rejects unreadable (NaN), zero, and the v1 "-1" unlimited marker, so
    // a malformed value falls through instead of dividing (matches cgroupV2Quota).
    return quota > 0 && period > 0 ? quota / period : null
  },

  // Gated on DYNO because elsewhere a v1 memory limit says nothing about CPU.
  // Unrecognized fingerprints (dedicated dynos, future sizes) fall through to
  // the processor count.
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
