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
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
  })

  test("second sample buffers normalized percentage", () => {
    mockReadings(10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1001: 50.0 })
  })

  test("normalizes by available cpus", () => {
    mockReadings(0.0, 1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(4.0)

    const collector = cpu("worker")
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    expect(configuration.buffer.flush().worker.cpu).toEqual({ 1001: 25.0 })
  })

  test("normalizes by fractional available cpus", () => {
    mockReadings(0.0, 0.25)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(0.5)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1001: 50.0 })
  })

  test("sample rounds percentage to two decimal places", () => {
    mockReadings(0.0, 1.0 / 3.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1001: 33.33 })
  })

  test("clamps to 100 percent", () => {
    mockReadings(0.0, 5.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1001: 100.0 })
  })

  test("negative usage delta skips and reseeds the baseline", () => {
    mockReadings(10.0, 5.0, 5.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    freezeTime(1002)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1002: 50.0 })
  })

  test("a usage source switch only reseeds the baseline", () => {
    jest
      .spyOn(Usage, "reading")
      .mockReturnValueOnce(read(5.0, "process"))
      .mockReturnValueOnce(read(500.0, "proc"))
      .mockReturnValueOnce(read(500.5, "proc"))
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    freezeTime(1002)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1002: 50.0 })
  })

  test("skips the sample when usage is unavailable", () => {
    mockReadings(null, null)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
  })

  test("non-positive elapsed delta skips the sample", () => {
    mockReadings(10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    expect(collector.sample()).toBeNull()
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
  })

  test("elapsed delta uses the monotonic clock not wall time", () => {
    mockReadings(10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    jest
      .spyOn(performance, "now")
      .mockReturnValueOnce(100_000)
      .mockReturnValueOnce(101_000)
    collector.sample()
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1000: 50.0 })
  })

  test("skips the sample when available cpus is null", () => {
    mockReadings(0.0, 1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(null)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
  })

  test("skips the sample when available cpus is zero", () => {
    mockReadings(0.0, 1.0)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(0.0)

    const collector = cpu()
    freezeTime(1000)
    collector.sample()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    expect(Object.keys(configuration.buffer.flush())).toHaveLength(0)
  })

  test("recovers after an initially unavailable usage source", () => {
    mockReadings(null, 10.0, 10.5)
    jest.spyOn(Usage, "availableCpus").mockReturnValue(1.0)

    const collector = cpu()
    freezeTime(1000)
    expect(collector.sample()).toBeNull()
    freezeTime(1001)
    expect(collector.sample()).toBeNull()
    freezeTime(1002)
    collector.sample()

    expect(configuration.buffer.flush().clock.cpu).toEqual({ 1002: 50.0 })
  })
})
