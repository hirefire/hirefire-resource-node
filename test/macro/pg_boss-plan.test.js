require("../support")

describe("pg-boss plan hooks", () => {
  let pgBossMacro

  beforeEach(() => {
    delete process.env.HIREFIRE_PG_BOSS_URL
    delete process.env.HIREFIRE_PG_BOSS_SCHEMA
    jest.resetModules()
    pgBossMacro = require("../../src/macro/pg_boss")
  })

  test("planOptions empty", () => {
    expect(pgBossMacro.planOptions("jqs", { a: 1 })).toEqual({})
    expect(pgBossMacro.planOptions("jql", { b: 2 })).toEqual({})
  })

  test("planConnectionOptions from url", () => {
    process.env.HIREFIRE_PG_BOSS_URL = "postgres://example/jobs"
    expect(pgBossMacro.planConnectionOptions()).toEqual({
      connection: "postgres://example/jobs",
    })
  })

  test("planConnectionOptions from url and schema", () => {
    process.env.HIREFIRE_PG_BOSS_URL = "postgres://example/jobs"
    process.env.HIREFIRE_PG_BOSS_SCHEMA = "custom_boss"
    expect(pgBossMacro.planConnectionOptions()).toEqual({
      connection: "postgres://example/jobs",
      schema: "custom_boss",
    })
  })

  test("planConnectionOptions schema only", () => {
    process.env.HIREFIRE_PG_BOSS_SCHEMA = "schema_only"
    expect(pgBossMacro.planConnectionOptions()).toEqual({
      schema: "schema_only",
    })
  })

  test("planConnectionOptions blank ignored", () => {
    process.env.HIREFIRE_PG_BOSS_URL = "   "
    process.env.HIREFIRE_PG_BOSS_SCHEMA = "  "
    expect(pgBossMacro.planConnectionOptions()).toEqual({})
  })

  test("planConnectionOptions trims url and schema", () => {
    process.env.HIREFIRE_PG_BOSS_URL = "  postgres://example/jobs  "
    process.env.HIREFIRE_PG_BOSS_SCHEMA = "  custom_boss  "
    expect(pgBossMacro.planConnectionOptions()).toEqual({
      connection: "postgres://example/jobs",
      schema: "custom_boss",
    })
  })

  test("supports jql and jqs only", () => {
    expect(pgBossMacro.supportsPlanStrategy("jqs")).toBe(true)
    expect(pgBossMacro.supportsPlanStrategy("jql")).toBe(true)
    expect(pgBossMacro.supportsPlanStrategy("rpm")).toBe(false)
    expect(pgBossMacro.supportsPlanStrategy("cpu")).toBe(false)
    expect(pgBossMacro.supportsPlanStrategy(Symbol.for("jqs"))).toBe(false)
    expect(pgBossMacro.supportsPlanStrategy("JQS")).toBe(false)
  })

  test("sample-wave hooks default to no-ops", () => {
    const Hooks = require("../../src/plan/hooks")
    expect(pgBossMacro.beforeSampleJobQueues).toBe(Hooks.beforeSampleJobQueues)
    expect(pgBossMacro.afterSampleJobQueues).toBe(Hooks.afterSampleJobQueues)
    expect(pgBossMacro.reinitAfterFork).toBe(Hooks.reinitAfterFork)
    expect(pgBossMacro.beforeSampleJobQueues()).toBeNull()
    expect(pgBossMacro.afterSampleJobQueues("token")).toBeUndefined()
    expect(pgBossMacro.reinitAfterFork()).toBeUndefined()
  })
})
