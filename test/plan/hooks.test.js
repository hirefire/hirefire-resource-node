const Hooks = require("../../src/plan/hooks")

describe("Plan.Hooks", () => {
  test("default plan hooks empty", () => {
    expect(Hooks.planOptions("jqs", { a: 1 })).toEqual({})
    expect(Hooks.planConnectionOptions()).toEqual({})
    expect(Hooks.supportsPlanStrategy("jql")).toBe(true)
    expect(Hooks.supportsPlanStrategy("jqs")).toBe(true)
    expect(Hooks.supportsPlanStrategy("nope")).toBe(false)
    expect(Hooks.queuesRequired()).toBe(false)
    expect(Hooks.beforeSampleJobQueues()).toBeNull()
    expect(Hooks.afterSampleJobQueues("anything")).toBeUndefined()
    expect(Hooks.reinitAfterFork()).toBeUndefined()
  })

  test("extract allowlists and coerces", () => {
    const schema = {
      jqs: {
        prioritized: "boolean",
        limit: "non_negative_integer",
      },
    }
    expect(
      Hooks.extractPlanOptions(
        "jqs",
        {
          prioritized: true,
          limit: "10",
          ignored: 1,
          badLimit: 1.5,
          badBool: "true",
        },
        schema,
      ),
    ).toEqual({ prioritized: true, limit: 10 })
  })

  test("coerce plan value", () => {
    expect(Hooks.coercePlanValue("boolean", true)).toBe(true)
    expect(Hooks.coercePlanValue("boolean", false)).toBe(false)
    expect(Hooks.coercePlanValue("boolean", "true")).toBeNull()
    expect(Hooks.coercePlanValue("non_negative_integer", 0)).toBe(0)
    expect(Hooks.coercePlanValue("non_negative_integer", -1)).toBeNull()
    expect(Hooks.coercePlanValue("non_negative_integer", 1.5)).toBeNull()
    expect(Hooks.coercePlanValue("non_negative_integer", "5")).toBe(5)
    expect(Hooks.coercePlanValue("non_negative_integer", "-1")).toBeNull()
    expect(Hooks.coercePlanValue("non_negative_integer", "5.0")).toBeNull()
  })

  test("extract drops invalid and non hash", () => {
    const schema = { jqs: { limit: "unknown" } }

    expect(Hooks.extractPlanOptions("jqs", null, schema)).toEqual({})
    expect(Hooks.extractPlanOptions("jqs", [], schema)).toEqual({})
    expect(Hooks.extractPlanOptions("jql", { limit: 2 }, schema)).toEqual({})
    expect(Hooks.extractPlanOptions("jqs", { limit: 2 }, schema)).toEqual({})
    expect(Hooks.coercePlanValue("unknown", 2)).toBeNull()
  })
})
