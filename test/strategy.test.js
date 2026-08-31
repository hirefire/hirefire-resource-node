const { rqt } = require("../src/strategy")

describe("strategy", () => {
  test("rqt accepts string", () => {
    expect(rqt("rqt")).toBe(true)
  })

  test("rqt rejects other strategies", () => {
    expect(rqt("jql")).toBe(false)
    expect(rqt(undefined)).toBe(false)
  })
})
