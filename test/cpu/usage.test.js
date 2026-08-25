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
  describe("totalSeconds", () => {
    test("prefers cgroup v2", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "usage_usec 2500000\nuser_usec 1000000",
      })
      expect(Usage.totalSeconds()).toBeCloseTo(2.5, 4)
    })

    test("falls back to cgroup v1", () => {
      stubReads({ [Usage.CGROUP_V1_USAGE]: "3000000000" })
      expect(Usage.totalSeconds()).toBeCloseTo(3.0, 4)
    })

    test("falls back to the proc namespace sum", () => {
      stubReads({
        "/proc/1/stat":
          "1 (ruby) S 0 1 1 0 -1 0 0 0 0 0 500 250 0 0 20 0 1 0 9 0 0",
        "/proc/2/stat":
          "2 (puma (worker)) S 1 1 1 0 -1 0 0 0 0 0 150 100 0 0 20 0 1 0 9 0 0",
      })
      jest
        .spyOn(Usage, "procStatPaths")
        .mockReturnValue(["/proc/1/stat", "/proc/2/stat"])

      expect(Usage.totalSeconds()).toBeCloseTo(10.0, 4)
    })

    test("cgroup v2 without a usage_usec line falls through to v1", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "user_usec 1000000\nsystem_usec 500000",
        [Usage.CGROUP_V1_USAGE]: "3000000000",
      })
      expect(Usage.totalSeconds()).toBeCloseTo(3.0, 4)
    })

    test("a malformed usage value falls through instead of returning NaN", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "usage_usec notanumber",
        [Usage.CGROUP_V1_USAGE]: "3000000000",
      })
      expect(Usage.totalSeconds()).toBeCloseTo(3.0, 4)
    })

    test("tolerates trailing whitespace in the usage line", () => {
      stubReads({
        [Usage.CGROUP_V2_USAGE]: "usage_usec 2500000 \nuser_usec 1",
      })
      expect(Usage.totalSeconds()).toBeCloseTo(2.5, 4)
    })

    test("falls back to the process clock", () => {
      stubReads({})
      jest.spyOn(Usage, "procStatPaths").mockReturnValue([])
      expect(typeof Usage.totalSeconds()).toBe("number")
    })
  })

  describe("reading", () => {
    test("reports the source that answered, for switch detection", () => {
      stubReads({ [Usage.CGROUP_V2_USAGE]: "usage_usec 2500000" })
      expect(Usage.reading()).toEqual({ seconds: 2.5, source: "cgroupV2" })
    })

    test("labels the fallback source when higher ones are absent", () => {
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
    test("null without proc", () => {
      jest.spyOn(Usage, "procStatPaths").mockReturnValue([])
      expect(Usage.procNamespaceSeconds()).toBeNull()
    })

    test("null when every entry is unreadable", () => {
      jest
        .spyOn(Usage, "procStatPaths")
        .mockReturnValue(["/proc/1/stat", "/proc/2/stat"])
      stubReads({})
      expect(Usage.procNamespaceSeconds()).toBeNull()
    })

    test("a garbled proc stat entry is skipped and the rest are counted", () => {
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
    test("falls back to os.cpus when availableParallelism is unavailable", () => {
      const original = os.availableParallelism
      os.availableParallelism = undefined
      try {
        jest.spyOn(os, "cpus").mockReturnValue([{}, {}, {}])
        expect(Usage.processorCount()).toBe(3)
      } finally {
        os.availableParallelism = original
      }
    })

    test("returns at least 1 when no cpu information is available", () => {
      const original = os.availableParallelism
      os.availableParallelism = undefined
      try {
        jest.spyOn(os, "cpus").mockReturnValue([])
        expect(Usage.processorCount()).toBe(1)
      } finally {
        os.availableParallelism = original
      }
    })

    test("falls back to 1 when the OS query throws", () => {
      const original = os.availableParallelism
      os.availableParallelism = undefined
      try {
        jest.spyOn(os, "cpus").mockImplementation(() => {
          throw new Error("os unavailable")
        })
        expect(Usage.processorCount()).toBe(1)
      } finally {
        os.availableParallelism = original
      }
    })
  })

  describe("statTicks", () => {
    test("parses around comm with spaces and parens", () => {
      const line =
        "4242 (rails (worker)) S 1 1 1 0 -1 0 0 0 0 0 500 250 0 0 20 0 1 0 100 0 0"
      expect(Usage.statTicks(line)).toBe(750)
    })

    test("null for a line without a comm paren", () => {
      expect(Usage.statTicks("123 ruby S 0 1 1 0")).toBeNull()
    })

    test("null for a truncated line", () => {
      expect(Usage.statTicks("123 (ruby) S 0 1")).toBeNull()
    })

    test("null for non-numeric utime or stime", () => {
      const line = "1 (ruby) S 0 0 0 0 0 0 0 0 0 0 x y 0 0 0 0 0 0 0 0"
      expect(Usage.statTicks(line)).toBeNull()
    })
  })

  describe("availableCpus", () => {
    test("reads cgroup v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "50000 100000" })
      expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
    })

    test("ignores unlimited v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "max 100000" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("ignores a non-numeric v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "garbage 100000" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("ignores a non-positive v2 quota", () => {
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "0 100000" })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("reads cgroup v1 quota", () => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: "150000",
        [Usage.CGROUP_V1_PERIOD]: "100000",
      })
      expect(Usage.availableCpus()).toBeCloseTo(1.5, 4)
    })

    test("ignores v1 unlimited quota", () => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: "-1",
        [Usage.CGROUP_V1_PERIOD]: "100000",
      })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("ignores a non-positive v1 quota", () => {
      stubReads({
        [Usage.CGROUP_V1_QUOTA]: "0",
        [Usage.CGROUP_V1_PERIOD]: "100000",
      })
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("falls back to the processor count", () => {
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

    test("cedar dedicated fingerprint falls through to the processor count", () => {
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

    test("reads the render entitlement from RENDER_CPU_COUNT", () => {
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

    test("render without a cpu count falls through to the processor count", () => {
      process.env.RENDER = "true"
      stubReads({})
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("render cpu count zero or non-numeric falls through", () => {
      process.env.RENDER = "true"
      stubReads({})

      process.env.RENDER_CPU_COUNT = "0"
      expect(Usage.availableCpus()).toBe(Usage.processorCount())

      process.env.RENDER_CPU_COUNT = "nope"
      expect(Usage.availableCpus()).toBe(Usage.processorCount())
    })

    test("cgroup quota wins over the render entitlement", () => {
      process.env.RENDER = "true"
      process.env.RENDER_CPU_COUNT = "8"
      stubReads({ [Usage.CGROUP_V2_QUOTA]: "50000 100000" })
      expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
    })
  })

  describe("clockTicks", () => {
    test("is the Linux USER_HZ default", () => {
      expect(Usage.CLOCK_TICKS).toBe(100)
    })
  })

  describe("read", () => {
    test("returns stripped file contents", () => {
      const file = path.join(os.tmpdir(), `usage-${process.pid}-${Date.now()}`)
      fs.writeFileSync(file, " 42\n")
      try {
        expect(Usage.read(file)).toBe("42")
      } finally {
        fs.unlinkSync(file)
      }
    })

    test("returns null for a missing path", () => {
      expect(Usage.read("/nonexistent/cgroup/file")).toBeNull()
    })

    test("returns null when the file disappears between check and read", () => {
      jest.spyOn(fs, "readFileSync").mockImplementation(() => {
        const error = new Error("ENOENT")
        error.code = "ENOENT"
        throw error
      })
      expect(Usage.read("/proc/1/stat")).toBeNull()
    })
  })
})
