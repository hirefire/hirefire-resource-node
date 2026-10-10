const Strategy = require("../src/strategy")

describe("strategy", () => {
  test("names every series once", () => {
    expect(Strategy.RQT).toBe("rqt")
    expect(Strategy.JQL).toBe("jql")
    expect(Strategy.JQS).toBe("jqs")
    expect(Strategy.CPU).toBe("cpu")
    expect(Strategy.WRK).toBe("wrk")
    expect(Strategy.JOB_QUEUE).toEqual(["jql", "jqs"])
  })

  test("rqt accepts string", () => {
    expect(Strategy.rqt("rqt")).toBe(true)
  })

  test("rqt rejects other strategies", () => {
    expect(Strategy.rqt("jql")).toBe(false)
    expect(Strategy.rqt(undefined)).toBe(false)
  })

  test("job queue accepts latency and size only", () => {
    expect(Strategy.jobQueue("jql")).toBe(true)
    expect(Strategy.jobQueue("jqs")).toBe(true)
    expect(Strategy.jobQueue("rqt")).toBe(false)
    expect(Strategy.jobQueue("wrk")).toBe(false)
    expect(Strategy.jobQueue(undefined)).toBe(false)
  })
})
