const { freezeTime } = require("./support")
const CPU = require("../src/cpu")
const Usage = require("../src/cpu/usage")
const Buffer = require("../src/buffer")

describe("CPU", () => {
  let configuration

  beforeEach(() => {
    configuration = { buffer: new Buffer() }
  })

  function cpu(name = "clock") {
    return new CPU(name, configuration)
  }

  // cpu.js reads Usage.reading() => { seconds, source }. A single source is used
  // across a scenario unless a test specifically exercises a source switch.
  function read(seconds, source = "proc") {
    return { seconds, source: seconds === null ? null : source }
  }

  function mockReadings(...secondsValues) {
    const spy = jest.spyOn(Usage, "reading")
    secondsValues.forEach((seconds) => spy.mockReturnValueOnce(read(seconds)))
    return spy
  }

  test("first sample only seeds the baseline", () => {
    mockReadings(10.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("second sample buffers normalized percentage", () => {
    mockReadings(10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    // 0.5 CPU-seconds over 1 wall-second on 1 available CPU => 50%.
    expect(configuration.buffer.flush().cpu).toEqual({
      clock: { 1001: [50.0] },
    })
  })

  test("normalizes by available cpus", () => {
    mockReadings(0.0, 1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(4.0)

    const collector = cpu("worker")
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    // 1 CPU-second over 1s on 4 CPUs => 25%.
    expect(configuration.buffer.flush().cpu).toEqual({
      worker: { 1001: [25.0] },
    })
  })

  test("clamps to 100 percent", () => {
    mockReadings(0.0, 5.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    expect(configuration.buffer.flush().cpu).toEqual({
      clock: { 1001: [100.0] },
    })
  })

  test("negative usage delta skips and reseeds the baseline", () => {
    mockReadings(10.0, 5.0, 5.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    // Source dropped 10.0 -> 5.0 between reads: skip, then re-baseline against 5.0.
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    freezeTime(1002)
    collector.sample()

    expect(configuration.buffer.flush().cpu).toEqual({
      clock: { 1002: [50.0] },
    })
  })

  test("a usage source switch only reseeds the baseline", () => {
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce(read(5.0, "process"))
      .mockReturnValueOnce(read(500.0, "proc")) // source switched between ticks
      .mockReturnValueOnce(read(500.5, "proc"))
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample() // baseline (process, 5.0)
    freezeTime(1001)
    // process -> proc: the 495s jump must reseed, not become a clamped 100% spike.
    expect(collector.sample()).toBeNull()
    freezeTime(1002)
    collector.sample() // proc -> proc: 0.5 over 1s on 1 CPU => 50%

    expect(configuration.buffer.flush().cpu).toEqual({
      clock: { 1002: [50.0] },
    })
  })

  test("skips the sample when usage is unavailable", () => {
    mockReadings(null, null)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("non-positive elapsed delta skips the sample", () => {
    // Same instant + positive usage delta isolates the elapsedDelta <= 0 backstop.
    mockReadings(10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("elapsed delta uses the monotonic clock not wall time", () => {
    mockReadings(10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    // Wall clock (Date.now) frozen at the same second for both reads: a wall-clock
    // elapsed delta would be 0 and skip. The monotonic clock (performance.now) advances
    // 1s, so 0.5 CPU-seconds over it => 50%, bucketed by the (frozen) wall second.
    freezeTime(1000)
    jest
      .spyOn(performance, "now")
      .mockReturnValueOnce(100_000)
      .mockReturnValueOnce(101_000)
    collector.sample()
    collector.sample()

    expect(configuration.buffer.flush().cpu).toEqual({
      clock: { 1000: [50.0] },
    })
  })

  test("skips the sample when available cpus is null", () => {
    mockReadings(0.0, 1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(null)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("skips the sample when available cpus is zero", () => {
    mockReadings(0.0, 1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(0.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("recovers after an initially unavailable usage source", () => {
    mockReadings(null, 10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    expect(collector.sample()).toBeNull() // source down: no baseline
    freezeTime(1001)
    expect(collector.sample()).toBeNull() // source back: seeds baseline
    freezeTime(1002)
    collector.sample() // 0.5 over 1s on 1 CPU => 50%

    expect(configuration.buffer.flush().cpu).toEqual({
      clock: { 1002: [50.0] },
    })
  })
})
