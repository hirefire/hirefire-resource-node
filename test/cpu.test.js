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

  test("first sample only seeds the baseline", () => {
    jest.spyOn(Usage, "totalSeconds").mockReturnValue(10.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("second sample buffers normalized percentage", () => {
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(10.0)
      .mockReturnValueOnce(10.5)
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
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(1.0)
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
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(5.0)
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
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(10.0)
      .mockReturnValueOnce(5.0)
      .mockReturnValueOnce(5.5)
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

  test("skips the sample when usage is unavailable", () => {
    jest.spyOn(Usage, "totalSeconds").mockReturnValue(null)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("non-positive wall delta skips the sample", () => {
    // Same instant + positive usage delta isolates the wallDelta <= 0 guard.
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(10.0)
      .mockReturnValueOnce(10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("skips the sample when available cpus is null", () => {
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(null)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("skips the sample when available cpus is zero", () => {
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(0.0)
      .mockReturnValueOnce(1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(0.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(configuration.buffer.flush().cpu).toEqual({})
  })

  test("recovers after an initially unavailable usage source", () => {
    jest
      .spyOn(Usage, "totalSeconds")
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(10.0)
      .mockReturnValueOnce(10.5)
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
