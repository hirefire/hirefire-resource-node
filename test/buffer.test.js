const { freezeTime } = require("./support")
const Buffer = require("../src/buffer")

describe("Buffer", () => {
  let buffer

  beforeEach(() => {
    buffer = new Buffer()
  })

  test("sample web", () => {
    freezeTime(100)
    buffer.sampleWeb(12)
    buffer.sampleWeb(8)

    expect(buffer.flush().web).toEqual({ 100: [12, 8] })
  })

  test("sample web groups by timestamp", () => {
    freezeTime(100)
    buffer.sampleWeb(12)
    freezeTime(101)
    buffer.sampleWeb(8)

    expect(buffer.flush().web).toEqual({ 100: [12], 101: [8] })
  })

  test("sample worker", () => {
    buffer.sampleWorker("worker", 42)
    buffer.sampleWorker("mailer", 18)

    expect(buffer.flush().workers).toEqual([
      { name: "worker", sample: 42 },
      { name: "mailer", sample: 18 },
    ])
  })

  test("flush returns all and resets", () => {
    freezeTime(100)
    buffer.sampleWeb(5)
    buffer.sampleWorker("worker", 10)

    const data = buffer.flush()
    expect(data.web).toEqual({ 100: [5] })
    expect(data.workers).toEqual([{ name: "worker", sample: 10 }])

    const empty = buffer.flush()
    expect(empty.web).toEqual({})
    expect(empty.workers).toEqual([])
  })

  test("sample worker latest wins per name", () => {
    buffer.sampleWorker("worker", 42)
    buffer.sampleWorker("mailer", 18)
    buffer.sampleWorker("worker", 7)

    expect(buffer.flush().workers).toEqual([
      { name: "worker", sample: 7 },
      { name: "mailer", sample: 18 },
    ])
  })

  test("sample web is bounded when dispatch is starved", () => {
    for (let second = 1000; second <= 1070; second++) {
      freezeTime(second)
      buffer.sampleWeb(1)
    }

    const web = buffer.flush().web
    const keys = Object.keys(web).map(Number)
    expect(keys.length).toBeLessThanOrEqual(66)
    expect(Math.min(...keys)).toBe(1006) // seconds beyond the TTL pruned
    expect(Math.max(...keys)).toBe(1070)
  })

  test("sample cpu is bounded when dispatch is starved", () => {
    for (let second = 1000; second <= 1070; second++) {
      freezeTime(second)
      buffer.sampleCpu("clock", 50.0)
    }

    const cpu = buffer.flush().cpu
    const keys = Object.keys(cpu.clock).map(Number)
    expect(keys.length).toBeLessThanOrEqual(66)
    expect(Math.max(...keys)).toBe(1070)
  })

  test("repopulate web within ttl", () => {
    freezeTime(100)
    buffer.repopulateWeb({ 90: [5], 30: [10] })

    const web = buffer.flush().web
    expect(web).toEqual({ 90: [5] })
    expect(web[30]).toBeUndefined()
  })

  test("repopulate web merges with existing", () => {
    freezeTime(100)
    buffer.sampleWeb(1)
    buffer.repopulateWeb({ 100: [2, 3] })

    expect(buffer.flush().web[100]).toEqual([1, 2, 3])
  })

  test("flush returns and resets cpu", () => {
    freezeTime(1000)
    buffer.sampleCpu("clock", 50.0)

    expect(buffer.flush().cpu).toEqual({ clock: { 1000: [50.0] } })
    expect(buffer.flush().cpu).toEqual({}) // second flush is reset
  })

  test("sample cpu groups values within a second", () => {
    freezeTime(1000)
    buffer.sampleCpu("clock", 40.0)
    buffer.sampleCpu("clock", 60.0)

    expect(buffer.flush().cpu).toEqual({ clock: { 1000: [40.0, 60.0] } })
  })

  test("a reserved cpu collector name does not pollute Object.prototype", () => {
    freezeTime(1000)
    buffer.sampleCpu("__proto__", 50.0)

    // The write must land in the buffer, not mutate the global prototype.
    expect({}[1000]).toBeUndefined()
    expect(buffer.flush().cpu["__proto__"]).toEqual({ 1000: [50.0] })
  })

  test("repopulate web keeps the second exactly at the ttl boundary", () => {
    // 40 == now - ttl: the boundary second is inside the window (drop is "<").
    freezeTime(100)
    buffer.repopulateWeb({ 40: [5] })

    expect(buffer.flush().web).toEqual({ 40: [5] })
  })
})
