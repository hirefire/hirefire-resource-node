const { freezeTime } = require("./support")
const Buffer = require("../src/buffer")

describe("Buffer", () => {
  let buffer

  beforeEach(() => {
    buffer = new Buffer()
  })

  test("sample rqt accumulates sum and count", () => {
    freezeTime(100)
    buffer.sample("web", "rqt", 10)
    buffer.sample("web", "rqt", 20)
    buffer.sample("web", "rqt", 30)
    const data = buffer.flush()
    expect(data.web.rqt[100]).toEqual({ sum: 60, count: 3 })
  })

  test("discard inherited clears all strategies", () => {
    freezeTime(100)
    buffer.sample("web", "rqt", 7)
    buffer.sample("worker", "jql", 5)
    buffer.discardInherited()
    expect(Object.keys(buffer.flush())).toHaveLength(0)
  })

  test("rqt caps count at sample count limit", () => {
    freezeTime(100)
    const series = buffer._seriesFor("web", "rqt")
    series[100] = { sum: 0, count: Buffer.SAMPLE_COUNT_LIMIT }
    buffer.sample("web", "rqt", 1)
    const bucket = buffer.flush().web.rqt[100]
    expect(bucket.count).toBe(Buffer.SAMPLE_COUNT_LIMIT)
    expect(bucket.sum).toBeCloseTo(0, 4)
  })

  test("sample ignores non finite and non numeric", () => {
    freezeTime(100)
    buffer.sample("web", "rqt", NaN)
    buffer.sample("web", "rqt", Infinity)
    buffer.sample("web", "cpu", /** @type {any} */ ("nope"))
    buffer.sample("web", "rqt", 5)
    const data = buffer.flush()
    expect(data.web.rqt[100]).toEqual({ sum: 5, count: 1 })
    expect(data.web.cpu).toBeUndefined()
  })

  test("repopulate rejects non rqt strategy", () => {
    freezeTime(100)
    buffer.repopulate("web", "cpu", { 100: { sum: 1, count: 1 } })
    expect(Object.keys(buffer.flush())).toHaveLength(0)
  })

  test("non rqt latest wins bare scalar", () => {
    freezeTime(100)
    buffer.sample("worker", "jql", 42)
    buffer.sample("worker", "jql", 7)
    buffer.sample("web", "cpu", 10.0)
    buffer.sample("web", "cpu", 37.5)
    const data = buffer.flush()
    expect(data.worker.jql[100]).toBe(7)
    expect(data.web.cpu[100]).toBe(37.5)
  })

  test("sample rqt groups by timestamp", () => {
    freezeTime(100)
    buffer.sample("web", "rqt", 12)
    freezeTime(101)
    buffer.sample("web", "rqt", 8)
    const data = buffer.flush()
    expect(data.web.rqt[100]).toEqual({ sum: 12, count: 1 })
    expect(data.web.rqt[101]).toEqual({ sum: 8, count: 1 })
  })

  test("flush returns and resets", () => {
    freezeTime(100)
    buffer.sample("web", "rqt", 5)
    buffer.sample("worker", "jql", 10)
    const data = buffer.flush()
    expect(data.web.rqt[100]).toEqual({ sum: 5, count: 1 })
    expect(data.worker.jql[100]).toBe(10)
    expect(Object.keys(buffer.flush())).toHaveLength(0)
  })

  test("multi strategy under one name", () => {
    freezeTime(100)
    buffer.sample("web", "rqt", 12)
    buffer.sample("web", "cpu", 37.5)
    const data = buffer.flush()
    expect(data.web.rqt[100]).toEqual({ sum: 12, count: 1 })
    expect(data.web.cpu[100]).toBe(37.5)
  })

  test("sample rqt bounded when dispatch is starved", () => {
    for (let second = 1000; second <= 1070; second++) {
      freezeTime(second)
      buffer.sample("web", "rqt", 1)
    }
    const series = buffer.flush().web.rqt
    expect(Object.keys(series).length).toBeLessThanOrEqual(66)
  })

  test("repopulate rqt within ttl", () => {
    freezeTime(100)
    buffer.repopulate("web", "rqt", {
      90: { sum: 5, count: 1 },
      30: { sum: 10, count: 1 },
    })
    const data = buffer.flush()
    expect(data.web.rqt[90]).toEqual({ sum: 5, count: 1 })
    expect(data.web.rqt[30]).toBeUndefined()
  })

  test("vector c repopulate merge sum and count", () => {
    freezeTime(100)
    buffer.repopulate("web", "rqt", { 100: { sum: 10, count: 1 } })
    buffer.sample("web", "rqt", 15)
    buffer.sample("web", "rqt", 15)
    expect(buffer.flush().web.rqt[100]).toEqual({ sum: 40, count: 3 })
  })

  test("repopulate accepts string keys", () => {
    freezeTime(100)
    buffer.repopulate("web", "rqt", {
      100: { sum: 5, count: 1 },
    })
    expect(buffer.flush().web.rqt[100]).toEqual({ sum: 5, count: 1 })
  })

  test("repopulate clamps to sample count limit", () => {
    freezeTime(100)
    const limit = Buffer.SAMPLE_COUNT_LIMIT
    buffer.repopulate("web", "rqt", { 100: { sum: limit, count: limit } })
    buffer.repopulate("web", "rqt", { 100: { sum: 100, count: 100 } })
    const bucket = buffer.flush().web.rqt[100]
    expect(bucket.count).toBe(limit)
    expect(bucket.sum / bucket.count).toBeCloseTo(1.0, 3)
  })

  test("repopulate rqt keeps the second exactly at the ttl boundary", () => {
    freezeTime(100)
    buffer.repopulate("web", "rqt", { 40: { sum: 5, count: 1 } })
    expect(buffer.flush().web.rqt).toEqual({ 40: { sum: 5, count: 1 } })
  })

  test("custom ttl is honored by repopulate", () => {
    const custom = new Buffer(10)
    freezeTime(100)
    custom.repopulate("web", "rqt", {
      95: { sum: 1, count: 1 },
      80: { sum: 2, count: 1 },
    })
    const data = custom.flush()
    expect(data.web.rqt[95]).toEqual({ sum: 1, count: 1 })
    expect(data.web.rqt[80]).toBeUndefined()
  })

  test("repopulate skips non hash and non positive count", () => {
    freezeTime(200)
    buffer.repopulate("web", "rqt", {
      190: 12,
      191: { sum: 5, count: 0 },
      192: { sum: 7, count: -1 },
      193: { sum: 9, count: 1 },
    })
    expect(buffer.flush().web.rqt).toEqual({ 193: { sum: 9, count: 1 } })
  })

  test("repopulate ignores array buckets", () => {
    freezeTime(100)
    buffer.repopulate("web", "rqt", { 100: [12, 8] })
    expect(Object.keys(buffer.flush())).toHaveLength(0)
  })

  test("repopulate replaces existing non object cell", () => {
    freezeTime(100)
    const series = buffer._seriesFor("web", "rqt")
    series[100] = 12
    buffer.repopulate("web", "rqt", { 100: { sum: 9, count: 1 } })
    expect(buffer.flush().web.rqt[100]).toEqual({ sum: 9, count: 1 })
  })

  test("repopulate prunes after merge", () => {
    freezeTime(1000)
    const series = buffer._seriesFor("web", "rqt")
    for (let s = 900; s < 970; s++) {
      series[s] = { sum: 1, count: 1 }
    }
    buffer.repopulate("web", "rqt", { 1000: { sum: 5, count: 1 } })
    const data = buffer.flush().web.rqt
    expect(data[1000]).toEqual({ sum: 5, count: 1 })
    expect(Object.keys(data).every((k) => parseInt(k, 10) >= 940)).toBe(true)
  })
})
