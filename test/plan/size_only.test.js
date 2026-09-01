const SizeOnly = require("../../src/plan/size_only")

describe("Plan.SizeOnly", () => {
  test("supports jqs only", () => {
    expect(SizeOnly.supportsPlanStrategy("jqs")).toBe(true)
    expect(SizeOnly.supportsPlanStrategy("jql")).toBe(false)
    expect(SizeOnly.supportsPlanStrategy("rpm")).toBe(false)
    expect(SizeOnly.supportsPlanStrategy("")).toBe(false)
  })
})
