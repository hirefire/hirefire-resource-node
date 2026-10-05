describe("BullMQ plan hooks", () => {
  let bullmq

  beforeEach(() => {
    delete process.env.HIREFIRE_BULLMQ_URL
    jest.resetModules()
    bullmq = require("../../../src/macro/bullmq")
  })

  test("planOptions maps skip_working to skipWorking for jqs", () => {
    expect(
      bullmq.planOptions("jqs", { skip_working: true, not_allowed: true }),
    ).toEqual({ skipWorking: true })
  })

  test("planOptions keeps a false skip_working", () => {
    expect(bullmq.planOptions("jqs", { skip_working: false })).toEqual({
      skipWorking: false,
    })
  })

  test("planOptions drops an absent or non-boolean skip_working", () => {
    expect(bullmq.planOptions("jqs", { a: 1 })).toEqual({})
    expect(bullmq.planOptions("jqs", { skip_working: "true" })).toEqual({})
    expect(bullmq.planOptions("jqs", { skip_working: 1 })).toEqual({})
    expect(bullmq.planOptions("jqs", { skip_working: null })).toEqual({})
    expect(bullmq.planOptions("jqs", { skipWorking: true })).toEqual({})
    expect(bullmq.planOptions("jqs", null)).toEqual({})
  })

  test("planOptions passes nothing to a jql entry", () => {
    expect(bullmq.planOptions("jql", { skip_working: true })).toEqual({})
  })

  test("planConnectionOptions from url", () => {
    process.env.HIREFIRE_BULLMQ_URL = "redis://example/1"
    expect(bullmq.planConnectionOptions()).toEqual({
      connection: "redis://example/1",
    })
  })

  test("planConnectionOptions blank ignored", () => {
    process.env.HIREFIRE_BULLMQ_URL = "   "
    expect(bullmq.planConnectionOptions()).toEqual({})
  })

  test("supports jqs only", () => {
    expect(bullmq.supportsPlanStrategy("jqs")).toBe(true)
    expect(bullmq.supportsPlanStrategy("jql")).toBe(false)
  })

  test("sample-wave hooks open and close the SCAN memo", () => {
    const Hooks = require("../../../src/plan/hooks")
    expect(bullmq.beforeSampleJobQueues).not.toBe(Hooks.beforeSampleJobQueues)
    expect(bullmq.beforeSampleJobQueues()).toBe(true)
    expect(bullmq.afterSampleJobQueues()).toBeUndefined()
    expect(bullmq.reinitAfterFork()).toBeUndefined()
  })
})
