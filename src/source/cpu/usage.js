const fs = require("fs")
const os = require("os")

const Usage = {
  CGROUP_V2_USAGE: "/sys/fs/cgroup/cpu.stat",
  CGROUP_V1_USAGE: "/sys/fs/cgroup/cpuacct/cpuacct.usage",
  CGROUP_V2_QUOTA: "/sys/fs/cgroup/cpu.max",
  CGROUP_V1_QUOTA: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
  CGROUP_V1_PERIOD: "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
  CEDAR_MEMORY_LIMIT: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
  PROC_DIR: "/proc",

  CLOCK_TICKS: 100,

  CEDAR_SHARED_ENTITLEMENTS: {
    536870912: 1.0,
    1073741824: 2.0,
  },

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
    return Number.isFinite(utime) && Number.isFinite(stime)
      ? utime + stime
      : null
  },

  processSeconds() {
    try {
      const { user, system } = process.cpuUsage()
      return (user + system) / 1000000.0
    } catch {
      return null
    }
  },

  availableCpus() {
    return (
      this.cgroupV2Quota() ??
      this.cgroupV1Quota() ??
      this.herokuEntitlement() ??
      this.renderEntitlement() ??
      this.processorCount()
    )
  },

  cgroupV2Quota() {
    const value = this.read(this.CGROUP_V2_QUOTA)
    if (!value) return null

    const [quota, period] = value.split(/\s+/)
    if (quota === undefined || quota === "max") return null

    const quotaValue = this.number(quota)
    const periodValue = this.number(period)
    return quotaValue > 0 && periodValue > 0 ? quotaValue / periodValue : null
  },

  cgroupV1Quota() {
    const quota = this.number(this.read(this.CGROUP_V1_QUOTA))
    const period = this.number(this.read(this.CGROUP_V1_PERIOD))
    return quota > 0 && period > 0 ? quota / period : null
  },

  herokuEntitlement() {
    if (!process.env.DYNO) return null

    const limit = this.read(this.CEDAR_MEMORY_LIMIT)
    if (!limit) return null

    return this.CEDAR_SHARED_ENTITLEMENTS[parseInt(limit)] ?? null
  },

  renderEntitlement() {
    if (!process.env.RENDER) return null

    const count = this.number(process.env.RENDER_CPU_COUNT)
    return count > 0 ? count : null
  },

  processorCount() {
    try {
      if (typeof os.availableParallelism === "function") {
        return os.availableParallelism()
      }
      const count = os.cpus().length
      return count > 0 ? count : 1
    } catch {
      return 1
    }
  },

  number(value) {
    if (value == null || value === "") return null
    const parsed = Number.parseFloat(value)
    return Number.isFinite(parsed) ? parsed : null
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
