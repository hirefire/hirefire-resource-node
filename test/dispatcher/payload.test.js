const { freezeTime } = require("../support")
const Payload = require("../../src/dispatcher/payload")

describe("Payload", () => {
  function build(data, { liveness = null, since = null, trace = null } = {}) {
    const omitted = []
    const result = Payload.build(data, { liveness, since, trace }, (...pair) =>
      omitted.push(pair),
    )
    return { ...result, omitted }
  }

  function rqt(sum, count) {
    return { sum, count }
  }

  test("an empty buffer without liveness gives no entry and no watermark", () => {
    expect(build({})).toEqual({ entries: [], watermark: null, omitted: [] })
  })

  test("job and cpu values are sent as bare numbers under their second", () => {
    const { entries, watermark } = build({
      worker: { jqs: { 1000: 12, 1001: 0 }, wrk: { 1000: 3 } },
      clock: { cpu: { 1000: 12.5 } },
    })

    expect(entries).toEqual([
      {
        name: "worker",
        metrics: { jqs: { 1000: 12, 1001: 0 }, wrk: { 1000: 3 } },
      },
      { name: "clock", metrics: { cpu: { 1000: 12.5 } } },
    ])
    expect(watermark).toBeNull()
  })

  test("request queue time is sent as its mean and its count", () => {
    const { entries } = build({
      web: { rqt: { 1000: rqt(30, 4), 1001: rqt(0, 0) } },
    })

    expect(entries).toEqual([
      { name: "web", metrics: { rqt: { 1000: [7.5, 4], 1001: [] } } },
    ])
  })

  test("liveness claims only the current second on the first build", () => {
    freezeTime(1000)

    expect(build({}, { liveness: "web" })).toEqual({
      entries: [{ name: "web", metrics: { rqt: { 1000: [] } } }],
      watermark: 1000,
      omitted: [],
    })
  })

  test("liveness claims every second after the last one sent and keeps the samples", () => {
    freezeTime(1003)

    const { entries, watermark } = build(
      { web: { rqt: { 1002: rqt(5, 1) } } },
      { liveness: "web", since: 1000 },
    )

    expect(entries[0].metrics.rqt).toEqual({ 1001: [], 1002: [5, 1], 1003: [] })
    expect(watermark).toBe(1003)
  })

  test("liveness reaches back no further than the backfill limit", () => {
    expect(Payload.RQT_BACKFILL_LIMIT).toBe(60)
    freezeTime(2000)

    const { entries, watermark } = build({}, { liveness: "web", since: 1000 })

    expect(Object.keys(entries[0].metrics.rqt).map(Number)).toEqual(
      Array.from({ length: 61 }, (_, index) => 1940 + index),
    )
    expect(watermark).toBe(2000)
  })

  test("a last second in the future claims the current second", () => {
    freezeTime(1000)

    const { entries, watermark } = build({}, { liveness: "web", since: 1500 })

    expect(Object.keys(entries[0].metrics.rqt)).toEqual(["1000"])
    expect(watermark).toBe(1000)
  })

  test("the entry with liveness comes first and carries its other series", () => {
    freezeTime(1000)

    const { entries } = build(
      {
        worker: { jqs: { 1000: 2 } },
        web: { rqt: { 1000: rqt(8, 2) }, cpu: { 1000: 40 } },
      },
      { liveness: "web" },
    )

    expect(entries.map((entry) => entry.name)).toEqual(["web", "worker"])
    expect(JSON.stringify(entries[0].metrics)).toBe(
      '{"rqt":{"1000":[4,2]},"cpu":{"1000":40}}',
    )
  })

  test("without liveness buffered request queue time is sent as it is", () => {
    freezeTime(1005)

    const { entries, watermark } = build({
      web: { rqt: { 1000: rqt(8, 2) } },
    })

    expect(entries[0].metrics.rqt).toEqual({ 1000: [4, 2] })
    expect(watermark).toBeNull()
  })

  test("the buffered buckets are not changed", () => {
    freezeTime(1003)
    const data = { web: { rqt: { 1002: rqt(5, 1) } } }

    build(data, { liveness: "web", since: 1000 })

    expect(data).toEqual({ web: { rqt: { 1002: { sum: 5, count: 1 } } } })
  })

  test("a value at the limit is sent and a value over it or under zero is left out and reported", () => {
    const limit = Payload.METRIC_VALUE_LIMIT
    expect(limit).toBe(1e15)

    const { entries, omitted } = build({
      worker: { jqs: { 1000: limit, 1001: limit + 1e3, 1002: -1, 1003: 0 } },
      web: {
        rqt: {
          1000: rqt(limit * 2, 1),
          1001: rqt(limit, 1),
          1002: rqt(-5, 1),
        },
      },
    })

    expect(entries[0].metrics.jqs).toEqual({ 1000: limit, 1003: 0 })
    expect(entries[1].metrics.rqt).toEqual({ 1001: [limit, 1] })
    expect(omitted).toEqual([
      ["worker", "jqs"],
      ["worker", "jqs"],
      ["web", "rqt"],
      ["web", "rqt"],
    ])
  })

  test("a value that is not a finite number is left out and reported", () => {
    const { entries, omitted } = build({
      worker: { jqs: { 1000: NaN, 1001: Infinity, 1002: 4 } },
      web: { rqt: { 1000: rqt(NaN, 1), 1001: rqt(Infinity, 2) } },
    })

    expect(entries).toEqual([{ name: "worker", metrics: { jqs: { 1002: 4 } } }])
    expect(omitted).toHaveLength(4)
  })

  test("a series or an entry with nothing left to send is dropped", () => {
    const { entries } = build({
      worker: { jqs: { 1000: -1 }, jql: {} },
      mailer: { jqs: { 1000: 4 } },
    })

    expect(entries).toEqual([{ name: "mailer", metrics: { jqs: { 1000: 4 } } }])
  })

  test("a name that an object would treat as its prototype is an entry like any other", () => {
    const data = Object.create(null)
    data.__proto__ = { jqs: { 1000: 1 } }
    data.constructor = { jqs: { 1000: 2 } }

    expect(build(data).entries).toEqual([
      { name: "__proto__", metrics: { jqs: { 1000: 1 } } },
      { name: "constructor", metrics: { jqs: { 1000: 2 } } },
    ])
  })

  test("the trace goes on the first entry and nowhere when there is none", () => {
    const trace = { wave_ms: 1.5, ops: [] }

    const { entries } = build(
      { worker: { jqs: { 1000: 1 } }, mailer: { jqs: { 1000: 2 } } },
      { trace },
    )

    expect(entries[0].sample_trace).toBe(trace)
    expect(entries[1]).not.toHaveProperty("sample_trace")
    expect(build({}, { trace }).entries).toEqual([])
  })

  test("traced tells whether the first entry carries a trace", () => {
    const data = { worker: { jqs: { 1000: 1 } } }

    expect(Payload.traced(build(data).entries)).toBe(false)
    expect(Payload.traced(build(data, { trace: { ops: [] } }).entries)).toBe(
      true,
    )
  })

  test("without trace returns the same entries less the trace and leaves the original", () => {
    const { entries } = build(
      { worker: { jqs: { 1000: 1 } }, mailer: { jqs: { 1000: 2 } } },
      { trace: { ops: [] } },
    )

    expect(Payload.withoutTrace(entries)).toEqual([
      { name: "worker", metrics: { jqs: { 1000: 1 } } },
      { name: "mailer", metrics: { jqs: { 1000: 2 } } },
    ])
    expect(Payload.traced(entries)).toBe(true)
  })
})
