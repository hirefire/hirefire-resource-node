const fs = require("fs")
const os = require("os")
const path = require("path")
const Usage = require("../../src/source/cpu/usage")

function stubReads(map) {
  jest
    .spyOn(Usage, "read")
    .mockImplementation((p) => (p in map ? map[p] : null))
}

describe("CPU.Usage", () => {
  describe("reading fallbacks", () => {
    test("reading falls back to proc namespace sum", () => {
      stubReads({
        "/proc/1/stat":
          "1 (ruby) S 0 1 1 0 -1 0 0 0 0 0 500 250 0 0 20 0 1 0 9 0 0",
        "/proc/2/stat":
          "2 (puma (worker)) S 1 1 1 0 -1 0 0 0 0 0 150 100 0 0 20 0 1 0 9 0 0",
      })
      jest
        .spyOn(Usage, "procStatPaths")
        .mockReturnValue(["/proc/1/stat", "/proc/2/stat"])

      expect(Usage.reading()).toEqual({ seconds: 10.0, source: "proc" })
    })

    test("cgroup v2 without a usage usec line falls through to v1", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "user_usec 1000000\nsystem_usec 500000",
        [Usage.CGROUP_V1_USAGE]: "3000000000",
      })
      expect(Usage.reading()).toEqual({ seconds: 3.0, source: "cgroupV1" })
    })

    test("reading falls through on malformed cgroup v2", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "usage_usec notanumber",
        [Usage.CGROUP_V1_USAGE]: "3000000000",
      })
      expect(Usage.reading()).toEqual({ seconds: 3.0, source: "cgroupV1" })
    })

    test("tolerates trailing whitespace in the usage line", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "usage_usec 2500000 \nuser_usec 1",
      })
      expect(Usage.reading()).toEqual({ seconds: 2.5, source: "cgroupV2" })
    })

    test("reading falls back to process clock", () => {
      stubReads({})
      jest.spyOn(Usage, "procStatPaths").mockReturnValue([])
      const { seconds, source } = Usage.reading()
      expect(typeof seconds).toBe("number")
      expect(source).toBe("process")
    })
  })

  describe("reading", () => {
    test("reading labels the active source", () => {
      stubReads({ [Usage.CGROUP_V2_USAGE]: "usage_usec 2500000" })
      expect(Usage.reading()).toEqual({ seconds: 2.5, source: "cgroupV2" })
    })

    test("reading labels the source it falls through to", () => {
      stubReads({ [Usage.CGROUP_V1_USAGE]: "3000000000" })
      expect(Usage.reading().source).toBe("cgroupV1")
    })

    test("cgroup v2 zero usage is accepted not fallthrough", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "usage_usec 0\nuser_usec 0",
      })
      expect(Usage.reading()).toEqual({ seconds: 0.0, source: "cgroupV2" })
    })

    test("cgroup v1 zero usage is accepted not fallthrough", () => {
      stubReads({ [Usage.CGROUP_V1_USAGE]: "0" })
      expect(Usage.reading()).toEqual({ seconds: 0.0, source: "cgroupV1" })
    })

    test("a throwing clock read falls through to a null reading", () => {
      stubReads({})
      jest.spyOn(Usage, "procStatPaths").mockReturnValue([])
      jest.spyOn(process, "cpuUsage").mockImplementation(() => {
        throw new Error("clock unavailable")
      })
      expect(Usage.reading()).toEqual({ seconds: null, source: null })
    })
  })

  describe("procNamespaceSeconds", () => {
    test("proc namespace seconds null without proc", () => {
      jest.spyOn(Usage, "procStatPaths").mockReturnValue([])
      expect(Usage.procNamespaceSeconds()).toBeNull()
    })

    test("proc namespace seconds null when every entry is unreadable", () => {
      jest
        .spyOn(Usage, "procStatPaths")
        .mockReturnValue(["/proc/1/stat", "/proc/2/stat"])
      stubReads({})
      expect(Usage.procNamespaceSeconds()).toBeNull()
    })

    test("proc namespace seconds null when every entry is garbled", () => {
      stubReads({
        "/proc/1/stat": "garbled entry without fields",
        "/proc/2/stat": "2 (puma) S 1 1",
      })
      jest
        .spyOn(Usage, "procStatPaths")
        .mockReturnValue(["/proc/1/stat", "/proc/2/stat"])

      expect(Usage.procNamespaceSeconds()).toBeNull()
    })

    test("a garbled proc stat entry is skipped and the rest counted", () => {
      stubReads({
        "/proc/1/stat":
          "1 (ruby) S 0 1 1 0 -1 0 0 0 0 0 500 250 0 0 20 0 1 0 9 0 0",
        "/proc/2/stat": "garbled entry without fields",
      })
      jest
        .spyOn(Usage, "procStatPaths")
        .mockReturnValue(["/proc/1/stat", "/proc/2/stat"])

      expect(Usage.procNamespaceSeconds()).toBeCloseTo(7.5, 4)
    })
  })

  describe("procStatPaths", () => {
    test("lists the stat path of every numeric proc entry", () => {
      jest
        .spyOn(fs, "readdirSync")
        .mockReturnValue(["1", "42", "self", "cpuinfo"])
      expect(Usage.procStatPaths()).toEqual(["/proc/1/stat", "/proc/42/stat"])
    })

    test("returns [] when /proc is unavailable", () => {
      jest.spyOn(fs, "readdirSync").mockImplementation(() => {
        throw new Error("ENOENT")
      })
      expect(Usage.procStatPaths()).toEqual([])
    })
  })

  describe("processorCount", () => {
    test("is the available parallelism of the machine", () => {
      jest.spyOn(os, "availableParallelism").mockReturnValue(6)

      expect(Usage.processorCount()).toBe(6)
    })
  })

  describe("statTicks", () => {
    test("stat ticks parses around comm with spaces and parens", () => {
      const line =
        "4242 (rails (worker)) S 1 1 1 0 -1 0 0 0 0 0 500 250 0 0 20 0 1 0 100 0 0"
      expect(Usage.statTicks(line)).toBe(750)
    })

    test("stat ticks returns null for a line without a comm paren", () => {
      expect(Usage.statTicks("123 ruby S 0 1 1 0")).toBeNull()
    })

    test("stat ticks returns null for a long line without a comm paren", () => {
      const line = "1 ruby S 0 1 1 0 -1 0 0 0 0 0 500 250 0 0 20 0 1 0 9 0 0"
      expect(Usage.statTicks(line)).toBeNull()
    })

    test("stat ticks returns null for a line that ends before the system time", () => {
      expect(Usage.statTicks("1 (ruby) S 0 0 0 0 0 0 0 0 0 0 500")).toBeNull()
    })

    test("stat ticks reads a line that ends with the system time", () => {
      expect(Usage.statTicks("1 (ruby) S 0 0 0 0 0 0 0 0 0 0 500 250")).toBe(
        750,
      )
    })

    test("stat ticks returns null for a truncated line", () => {
      expect(Usage.statTicks("123 (ruby) S 0 1")).toBeNull()
    })

    test("stat ticks returns null for non numeric fields", () => {
      const line = "1 (ruby) S 0 0 0 0 0 0 0 0 0 0 x y 0 0 0 0 0 0 0 0"
      expect(Usage.statTicks(line)).toBeNull()
    })
  })

  describe("availableCpus", () => {
    test("available cpus reads cgroup v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "50000 100000" })
      expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
    })

    test("available cpus ignores unlimited v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "max 100000" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("available cpus falls through on malformed quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "garbage 100000" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("available cpus ignores a non positive v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "0 100000" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test.each([
      ["a zero quota", "0 100000", null],
      ["a zero period", "100000 0", null],
      ["a negative period", "100000 -1", null],
      ["an unlimited quota", "max 100000", null],
      ["a quota without a period", "100000", null],
      ["a quota and a period of one", "1 1", 1],
      ["two cores", "200000 100000", 2],
    ])("cgroup v2 quota with %s", (_name, content, expected) => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: content })
      expect(Usage.cgroupV2Quota()).toBe(expected)
    })

    test("cgroup v2 quota is null without the file", () => {
      stubReads({})
      expect(Usage.cgroupV2Quota()).toBeNull()
    })

    test.each([
      ["a zero quota", "0", "100000", null],
      ["a zero period", "100000", "0", null],
      ["an unlimited quota", "-1", "100000", null],
      ["a missing period", "100000", null, null],
      ["a missing quota", null, "100000", null],
      ["an empty quota", "", "100000", null],
      ["a quota and a period of one", "1", "1", 1],
      ["two cores", "200000", "100000", 2],
    ])("cgroup v1 quota with %s", (_name, quota, period, expected) => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: quota,
        [Usage.CGROUP_V1_PERIOD]: period,
      })
      expect(Usage.cgroupV1Quota()).toBe(expected)
    })

    test("the entitlements answer null where they do not apply", () => {
      stubReads({})
      expect(Usage.herokuEntitlement()).toBeNull()
      expect(Usage.renderEntitlement()).toBeNull()

      process.env.DYNO = "web.1"
      expect(Usage.herokuEntitlement()).toBeNull()
      stubReads({ [Usage.CEDAR_MEMORY_LIMIT]: "8589934592" })
      expect(Usage.herokuEntitlement()).toBeNull()

      process.env.RENDER = "true"
      expect(Usage.renderEntitlement()).toBeNull()
    })

    test("available cpus reads cgroup v1 quota", () => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: "150000",
        [Usage.CGROUP_V1_PERIOD]: "100000",
      })
      expect(Usage.availableCpus()).toBeCloseTo(1.5, 4)
    })

    test("available cpus ignores v1 unlimited quota", () => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: "-1",
        [Usage.CGROUP_V1_PERIOD]: "100000",
      })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("available cpus ignores a non positive v1 quota", () => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: "0",
        [Usage.CGROUP_V1_PERIOD]: "100000",
      })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("available cpus falls back to processor count", () => {
      stubReads({})
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("cedar shared 1x entitlement from memory fingerprint", () => {
      process.env.DYNO = "worker.1"
      stubReads({ [Usage.CEDAR_MEMORY_LIMIT]: "536870912" })
      expect(Usage.availableCpus()).toBe(1.0)
    })

    test("cedar shared 2x entitlement from memory fingerprint", () => {
      process.env.DYNO = "worker.1"
      stubReads({ [Usage.CEDAR_MEMORY_LIMIT]: "1073741824" })
      expect(Usage.availableCpus()).toBe(2.0)
    })

    test("cedar dedicated fingerprint falls through to processor count", () => {
      process.env.DYNO = "web.1"
      stubReads({ [Usage.CEDAR_MEMORY_LIMIT]: "2684354560" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("heroku entitlement without a readable memory limit falls through", () => {
      process.env.DYNO = "web.1"
      stubReads({ [Usage.CEDAR_MEMORY_LIMIT]: null })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("entitlement ignored off heroku", () => {
      stubReads({ [Usage.CEDAR_MEMORY_LIMIT]: "536870912" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("cgroup quota wins over entitlement", () => {
      process.env.DYNO = "web-5fb9c979-lft2l"
      stubReads({
        [Usage.CGROUP_V2_QUOTA]: "90000 100000",
        [Usage.CEDAR_MEMORY_LIMIT]: "536870912",
      })
      expect(Usage.availableCpus()).toBeCloseTo(0.9, 4)
    })

    test("render entitlement from render cpu count", () => {
      process.env.RENDER = "true"
      process.env.RENDER_CPU_COUNT = "0.5"
      stubReads({})
      expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
    })

    test("render entitlement ignored off render", () => {
      process.env.RENDER_CPU_COUNT = "8"
      stubReads({})
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("render without a cpu count falls through to processor count", () => {
      process.env.RENDER = "true"
      stubReads({})
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("render cpu count zero or non numeric falls through", () => {
      process.env.RENDER = "true"
      stubReads({})

      process.env.RENDER_CPU_COUNT = "0"
      expect(Usage.availableCpus()).toBe(Usage.processorCount())

      process.env.RENDER_CPU_COUNT = "nope"
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("cgroup quota wins over render entitlement", () => {
      process.env.RENDER = "true"
      process.env.RENDER_CPU_COUNT = "8"
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "50000 100000" })
      expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
    })
  })

  describe("processSeconds", () => {
    test("adds the user and the system time of the process, in seconds", () => {
      jest
        .spyOn(process, "cpuUsage")
        .mockReturnValue({ user: 1_500_000, system: 500_000 })

      expect(Usage.processSeconds()).toBe(2)
    })
  })

  describe("the files it reads", () => {
    test("are the cgroup, cpuacct, and memory files of the platform", () => {
      expect({
        v2Usage: Usage.CGROUP_V2_USAGE,
        v1Usage: Usage.CGROUP_V1_USAGE,
        v2Quota: Usage.CGROUP_V2_QUOTA,
        v1Quota: Usage.CGROUP_V1_QUOTA,
        v1Period: Usage.CGROUP_V1_PERIOD,
        memory: Usage.CEDAR_MEMORY_LIMIT,
        proc: Usage.PROC_DIR,
      }).toEqual({
        v2Usage: "/sys/fs/cgroup/cpu.stat",
        v1Usage: "/sys/fs/cgroup/cpuacct/cpuacct.usage",
        v2Quota: "/sys/fs/cgroup/cpu.max",
        v1Quota: "/sys/fs/cgroup/cpu/cpu.cfs_quota_us",
        v1Period: "/sys/fs/cgroup/cpu/cpu.cfs_period_us",
        memory: "/sys/fs/cgroup/memory/memory.limit_in_bytes",
        proc: "/proc",
      })
    })
  })

  describe("clockTicks", () => {
    test("clock ticks is the linux user hz default", () => {
      expect(Usage.CLOCK_TICKS).toBe(100)
    })
  })

  describe("read", () => {
    test("read returns stripped file contents", () => {
      const file = path.join(os.tmpdir(), `usage-${process.pid}-${Date.now()}`)
      fs.writeFileSync(file, " 42\n")
      try {
        expect(Usage.read(file)).toBe("42")
      } finally {
        fs.unlinkSync(file)
      }
    })

    test("read returns null for missing path", () => {
      expect(Usage.read("/nonexistent/cgroup/file")).toBeNull()
    })

    test("read returns null when the file disappears between check and read", () => {
      jest.spyOn(fs, "readFileSync").mockImplementation(() => {
        const error = new Error("ENOENT")
        error.code = "ENOENT"
        throw error
      })
      expect(Usage.read("/proc/1/stat")).toBeNull()
    })
  })
})
