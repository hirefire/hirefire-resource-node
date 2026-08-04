require("../support")

describe("Bull plan hooks", () => {
  let bull
  let savedHirefireBullUrl

  beforeAll(() => {
    savedHirefireBullUrl = process.env.HIREFIRE_BULL_URL
  })

  afterAll(() => {
    if (savedHirefireBullUrl === undefined) delete process.env.HIREFIRE_BULL_URL
    else process.env.HIREFIRE_BULL_URL = savedHirefireBullUrl
  })

  beforeEach(() => {
    delete process.env.HIREFIRE_BULL_URL
    jest.resetModules()
    bull = require("../../src/macro/bull")
  })

  test("planOptions empty", () => {
    expect(bull.planOptions("jqs", { a: 1 })).toEqual({})
  })

  test("planConnectionOptions from url", () => {
    process.env.HIREFIRE_BULL_URL = "redis://example/1"
    expect(bull.planConnectionOptions()).toEqual({
      connection: "redis://example/1",
    })
  })

  test("planConnectionOptions trims surrounding whitespace on url", () => {
    process.env.HIREFIRE_BULL_URL = "  redis://example/2  "
    expect(bull.planConnectionOptions()).toEqual({
      connection: "redis://example/2",
    })
  })

  test("planConnectionOptions blank ignored", () => {
    process.env.HIREFIRE_BULL_URL = "   "
    expect(bull.planConnectionOptions()).toEqual({})
  })

  test("planConnectionOptions unset is empty", () => {
    delete process.env.HIREFIRE_BULL_URL
    expect(bull.planConnectionOptions()).toEqual({})
  })

  test("supports jqs only", () => {
    expect(bull.supportsPlanStrategy("jqs")).toBe(true)
    expect(bull.supportsPlanStrategy("jql")).toBe(false)
    expect(bull.supportsPlanStrategy("rpm")).toBe(false)
    expect(bull.supportsPlanStrategy("")).toBe(false)
    expect(bull.supportsPlanStrategy(Symbol("jqs"))).toBe(false)
    // String coercion: only the literal strategy name "jqs".
    expect(bull.supportsPlanStrategy("JQS")).toBe(false)
  })

  test("planOptions always empty regardless of strategy or options", () => {
    expect(bull.planOptions("jql", { connection: "x" })).toEqual({})
    expect(bull.planOptions("jqs", null)).toEqual({})
    expect(bull.planOptions(undefined, undefined)).toEqual({})
  })

  test("sample-wave hooks default to no-ops", () => {
    const Hooks = require("../../src/plan/hooks")
    expect(bull.beforeSampleJobQueues).toBe(Hooks.beforeSampleJobQueues)
    expect(bull.afterSampleJobQueues).toBe(Hooks.afterSampleJobQueues)
    expect(bull.reinitAfterFork).toBe(Hooks.reinitAfterFork)
    expect(bull.beforeSampleJobQueues()).toBeNull()
    expect(bull.afterSampleJobQueues("token")).toBeUndefined()
    expect(bull.reinitAfterFork()).toBeUndefined()
  })
})
