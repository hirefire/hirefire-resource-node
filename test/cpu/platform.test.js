require("../support")
const fs = require("fs")
const path = require("path")
const Usage = require("../../src/cpu/usage")

// Closed-world platform goldens for Usage.
// Fixture bodies are verbatim extracts from hirefire-resource/cpu-platform-samples.md
// (capture date 2026-07-27). Do not invent platform samples here.

const FIXTURE_ROOT = path.join(__dirname, "../fixtures/cpu")

// Loud default so host os.cpus / availableParallelism never becomes a silent entitlement.
// Capture-meta nproc values (shared 8, Perf 2/8/4/8/16, Fir 48/96, Render 8/32)
// are documented in comments only; tests that care pass an explicit nproc.
const NPROC_SENTINEL = 97

// Cedar Performance / Private / Shield non-fingerprint sizes. Limits are real
// capture bodies (2026-07-27). Live nproc was M=2, L=8, L-RAM=4, XL=8, 2XL=16;
// tests stub NPROC_SENTINEL so a missed fingerprint still proves map-miss fallthrough.
const CEDAR_DEDICATED = [
  "performance_m",
  "performance_l",
  "performance_l_ram",
  "performance_xl",
  "performance_2xl",
]

const FIR_CPU_MAX = [
  ["dyno_1c_0_5gb_cpu_max.txt", 0.9],
  ["cpu_max_2c.txt", 1.8],
  ["cpu_max_4c.txt", 3.6],
  ["cpu_max_8c.txt", 7.2],
  ["cpu_max_16c.txt", 14.4],
  ["cpu_max_32c.txt", 28.8],
]

const RENDER_PLAN_MATRIX = [
  ["free_cpu_max.txt", 0.15],
  ["starter_cpu_max.txt", 0.5],
  ["standard_cpu_max.txt", 1.0],
  ["pro_cpu_max.txt", 2.0],
  ["pro_plus_cpu_max.txt", 4.0],
  ["pro_max_cpu_max.txt", 4.0],
  ["pro_ultra_cpu_max.txt", 8.0],
]

const RENDER_CPU_COUNT_STRINGS = [
  ["0.15", 0.15],
  ["0.50", 0.5],
  ["1", 1.0],
  ["8", 8.0],
]

function fixture(relativePath) {
  const body = fs.readFileSync(path.join(FIXTURE_ROOT, relativePath), "utf8")
  return body
    .split("\n")
    .filter((line) => !line.startsWith("#"))
    .join("\n")
    .trim()
}

// Default every Usage.read → null (no host /proc or cgroup leak), then inject
// only the fixture map. procStatPaths never sees the real host. processSeconds is
// null so usage never falls through to the process clock unless a test re-stubs.
// processorCount always stubs (default NPROC_SENTINEL). CLOCK_TICKS is already 100.
function closedWorld({
  reads = {},
  procPaths = [],
  nproc = NPROC_SENTINEL,
} = {}) {
  jest.spyOn(Usage, "read").mockImplementation((p) => {
    return Object.prototype.hasOwnProperty.call(reads, p) ? reads[p] : null
  })
  jest.spyOn(Usage, "procStatPaths").mockReturnValue(Array.from(procPaths))
  jest.spyOn(Usage, "processorCount").mockReturnValue(nproc)
  jest.spyOn(Usage, "processSeconds").mockReturnValue(null)
}

describe("CPU.Usage platform goldens", () => {
  // --- Cedar (Heroku classic): entitlement ---

  test("cedar basic/1x fingerprint not host nproc", () => {
    process.env.DYNO = "web.1"
    // Capture nproc on shared Basic/1X was 8 (host). Fingerprint must win.
    closedWorld({
      reads: {
        [Usage.CEDAR_MEMORY_LIMIT]: fixture("cedar/memory_limit_basic.txt"),
      },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(1.0, 4)
  })

  test("cedar standard-2x fingerprint not host nproc", () => {
    process.env.DYNO = "web.1"
    closedWorld({
      reads: {
        [Usage.CEDAR_MEMORY_LIMIT]: fixture(
          "cedar/memory_limit_standard_2x.txt",
        ),
      },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(2.0, 4)
  })

  test("cedar performance dedicated fingerprint miss falls to nproc", () => {
    // Real limits from Performance (and matching Private/Shield) captures.
    // Expects prove CEDAR_MEMORY_LIMIT is read (fixture applied). NPROC_SENTINEL
    // proves the body is not in CEDAR_SHARED_ENTITLEMENTS (map miss → fallthrough).
    // Unread limit alone would also fall through to 97 without the call assertion.
    for (const name of CEDAR_DEDICATED) {
      process.env.DYNO = "web.1"
      const body = fixture(`cedar/memory_limit_${name}.txt`)
      closedWorld({ nproc: NPROC_SENTINEL })
      Usage.read.mockImplementation((p) =>
        p === Usage.CEDAR_MEMORY_LIMIT ? body : null,
      )

      expect(Usage.availableCpus()).toBeCloseTo(NPROC_SENTINEL, 4)
      expect(Usage.read).toHaveBeenCalledWith(Usage.CEDAR_MEMORY_LIMIT)
      jest.restoreAllMocks()
    }
  })

  // Private-S and Shield-S share the 1 GiB Standard-2X fingerprint key
  // (cpu-platform-samples.md decision log: no Private/Shield special case).
  test("cedar private-s and shield-s one gib fingerprint no space special case", () => {
    process.env.DYNO = "run.8256"
    // High nproc so only fingerprint yields 2.0 (live Private/Shield-S nproc is 2).
    closedWorld({
      reads: {
        [Usage.CEDAR_MEMORY_LIMIT]: fixture(
          "cedar/memory_limit_standard_2x.txt",
        ),
      },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(2.0, 4)
  })

  test("cedar dyno unset ignores memory fingerprint", () => {
    // DYNO cleared by support. Shared 512 MiB limit must not fingerprint.
    closedWorld({
      reads: {
        [Usage.CEDAR_MEMORY_LIMIT]: fixture("cedar/memory_limit_basic.txt"),
      },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(8.0, 4)
  })

  // --- Cedar: /proc usage ---

  test("cedar basic formation puma master and worker proc sum", () => {
    const master = fixture("cedar/proc_basic_formation_puma_master.txt")
    const worker = fixture("cedar/proc_basic_formation_puma_worker.txt")
    const paths = ["/proc/2/stat", "/proc/50/stat"]

    closedWorld({
      reads: {
        "/proc/2/stat": master,
        "/proc/50/stat": worker,
      },
      procPaths: paths,
    })

    // PID2: 3793+1400=5193, PID50: 80+15=95 → 5288 ticks / 100 = 52.88
    const { seconds, source } = Usage.reading()
    expect(source).toBe("proc")
    expect(seconds).toBeCloseTo(52.88, 4)
  })

  test("cedar oneoff zero tick ps-run stays on proc", () => {
    const stat = fixture("cedar/proc_basic_oneoff_ps_run.txt")
    closedWorld({
      reads: { "/proc/1/stat": stat },
      procPaths: ["/proc/1/stat"],
    })
    // closedWorld nulls processSeconds; re-stub high to prove no fallthrough.
    Usage.processSeconds.mockReturnValue(99.0)

    const { seconds, source } = Usage.reading()
    expect(source).toBe("proc")
    expect(seconds).toBeCloseTo(0.0, 4)
  })

  // --- Fir (Heroku CNB) ---

  test("fir dyno-1c-0.5gb cpu.stat usage", () => {
    closedWorld({
      reads: {
        [Usage.CGROUP_V2_USAGE]: fixture("fir/dyno_1c_0_5gb_cpu_stat.txt"),
      },
    })

    const { seconds, source } = Usage.reading()
    expect(source).toBe("cgroupV2")
    expect(seconds).toBeCloseTo(31663 / 1000000.0, 4)
  })

  test("fir cpu.max beats host nproc", () => {
    process.env.DYNO = "run-nss86zptrv-7fpx8"
    // Capture host nproc was 96; trap with that value.
    closedWorld({
      reads: {
        [Usage.CGROUP_V2_QUOTA]: fixture("fir/dyno_1c_0_5gb_cpu_max.txt"),
      },
      nproc: 96,
    })

    expect(Usage.availableCpus()).toBeCloseTo(0.9, 4)
  })

  test("fir parametric unique entitlements", () => {
    process.env.DYNO = "web-fir-1"
    for (const [file, expected] of FIR_CPU_MAX) {
      closedWorld({
        reads: { [Usage.CGROUP_V2_QUOTA]: fixture(`fir/${file}`) },
        nproc: 96,
      })

      expect(Usage.availableCpus()).toBeCloseTo(expected, 4)
      jest.restoreAllMocks()
    }
  })

  test("fir dyno set with cpu.max does not use cedar memory limit", () => {
    process.env.DYNO = "run-nss86zptrv-7fpx8"
    // Live Fir has no memory.limit_in_bytes path. Closed world leaves it null.
    closedWorld({
      reads: {
        [Usage.CGROUP_V2_QUOTA]: fixture("fir/dyno_1c_0_5gb_cpu_max.txt"),
      },
      nproc: 96,
    })

    expect(Usage.read(Usage.CEDAR_MEMORY_LIMIT)).toBeNull()
    expect(Usage.availableCpus()).toBeCloseTo(0.9, 4)
  })

  // --- Render ---

  test("render starter cpu.stat usage", () => {
    closedWorld({
      reads: {
        [Usage.CGROUP_V2_USAGE]: fixture("render/starter_cpu_stat.txt"),
      },
    })

    const { seconds, source } = Usage.reading()
    expect(source).toBe("cgroupV2")
    expect(seconds).toBeCloseTo(858123 / 1000000.0, 4)
  })

  test("render free cpu.max beats marketing 0.1 env", () => {
    process.env.RENDER = "true"
    // Marketing/docs say 0.1; live Free cpu.max is 0.15. Env must not win.
    process.env.RENDER_CPU_COUNT = "0.1"
    closedWorld({
      reads: { [Usage.CGROUP_V2_QUOTA]: fixture("render/free_cpu_max.txt") },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(0.15, 4)
  })

  test("render free RENDER_CPU_COUNT without cgroup", () => {
    process.env.RENDER = "true"
    process.env.RENDER_CPU_COUNT = "0.15"
    closedWorld({ nproc: 8 })

    expect(Usage.availableCpus()).toBeCloseTo(0.15, 4)
  })

  test("render full plan matrix cpu.max", () => {
    process.env.RENDER = "true"
    // RENDER_CPU_COUNT left unset so only cpu.max can supply entitlement.
    for (const [file, expected] of RENDER_PLAN_MATRIX) {
      closedWorld({
        reads: { [Usage.CGROUP_V2_QUOTA]: fixture(`render/${file}`) },
        nproc: 32,
      })

      expect(Usage.availableCpus()).toBeCloseTo(expected, 4)
      jest.restoreAllMocks()
    }
  })

  test("render RENDER_CPU_COUNT strings without cgroup", () => {
    process.env.RENDER = "true"
    for (const [raw, expected] of RENDER_CPU_COUNT_STRINGS) {
      process.env.RENDER_CPU_COUNT = raw
      closedWorld({ nproc: 32 })

      expect(Usage.availableCpus()).toBeCloseTo(expected, 4)
      jest.restoreAllMocks()
    }
  })

  test("render quota beats misleading RENDER_CPU_COUNT low", () => {
    process.env.RENDER = "true"
    process.env.RENDER_CPU_COUNT = "0.1"
    closedWorld({
      reads: { [Usage.CGROUP_V2_QUOTA]: fixture("render/starter_cpu_max.txt") },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
  })

  test("render quota beats misleading RENDER_CPU_COUNT high", () => {
    process.env.RENDER = "true"
    process.env.RENDER_CPU_COUNT = "8"
    closedWorld({
      reads: { [Usage.CGROUP_V2_QUOTA]: fixture("render/starter_cpu_max.txt") },
      nproc: 8,
    })

    expect(Usage.availableCpus()).toBeCloseTo(0.5, 4)
  })

  test("render pro ultra cpu.max beats host nproc 32", () => {
    process.env.RENDER = "true"
    // RENDER_CPU_COUNT unset: only cpu.max can yield 8.0 against nproc trap 32.
    closedWorld({
      reads: {
        [Usage.CGROUP_V2_QUOTA]: fixture("render/pro_ultra_cpu_max.txt"),
      },
      nproc: 32,
    })

    expect(Usage.availableCpus()).toBeCloseTo(8.0, 4)
  })
})
