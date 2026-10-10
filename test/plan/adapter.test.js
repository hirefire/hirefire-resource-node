const Adapter = require("../../src/plan/adapter")

describe("Plan adapter", () => {
  function adapter(fields = {}) {
    return new Adapter({
      macro: () => ({}),
      packages: [],
      strategies: ["jqs"],
      ...fields,
    })
  }

  test("the library counts as loaded when every package of the adapter is installed", () => {
    expect(adapter({ packages: ["jest"] }).libraryLoaded()).toBe(true)
    expect(adapter({ packages: ["jest", "nock"] }).libraryLoaded()).toBe(true)
    expect(
      adapter({
        packages: ["jest", "hirefire-no-such-package"],
      }).libraryLoaded(),
    ).toBe(false)
    expect(
      adapter({
        packages: ["hirefire-no-such-package", "jest"],
      }).libraryLoaded(),
    ).toBe(false)
  })

  test("the packages are looked up once", () => {
    const present = adapter({ packages: ["jest"] })
    const absent = adapter({ packages: ["hirefire-no-such-package"] })
    expect(present.libraryLoaded()).toBe(true)
    expect(absent.libraryLoaded()).toBe(false)

    present.packages = ["hirefire-no-such-package"]
    absent.packages = ["jest"]

    expect(present.libraryLoaded()).toBe(true)
    expect(absent.libraryLoaded()).toBe(false)
  })

  test("supports tells the strategies of the adapter", () => {
    const sizeOnly = adapter()
    const both = adapter({ strategies: ["jql", "jqs"] })

    expect(sizeOnly.supports("jqs")).toBe(true)
    expect(sizeOnly.supports("jql")).toBe(false)
    expect(both.supports("jql")).toBe(true)
    expect(both.supports("rpm")).toBe(false)
  })

  test.each([
    ["jqs", { skip_working: true }, { skipWorking: true }],
    ["jqs", { skip_working: false }, { skipWorking: false }],
    ["jqs", { skip_working: true, server: 1 }, { skipWorking: true }],
    ["jqs", { skip_working: "true" }, {}],
    ["jqs", { skip_working: 1 }, {}],
    ["jqs", { skip_working: null }, {}],
    ["jqs", {}, {}],
    ["jqs", null, {}],
    ["jqs", undefined, {}],
    ["jqs", "skip_working", {}],
    ["jqs", [true], {}],
    ["jql", { skip_working: true }, {}],
  ])("options of a %s entry with %j are %j", (strategy, raw, expected) => {
    expect(adapter().options(strategy, raw)).toEqual(expected)
  })

  test("connection options come from the variables of the adapter, trimmed, and only when set", () => {
    const planned = adapter({
      environment: {
        connection: "HIREFIRE_T_URL",
        schema: "HIREFIRE_T_SCHEMA",
      },
    })
    try {
      expect(planned.connectionOptions()).toEqual({})

      process.env.HIREFIRE_T_URL = "  redis://127.0.0.1:6379/2 "
      process.env.HIREFIRE_T_SCHEMA = "   "
      expect(planned.connectionOptions()).toEqual({
        connection: "redis://127.0.0.1:6379/2",
      })

      process.env.HIREFIRE_T_SCHEMA = "jobs"
      expect(planned.connectionOptions()).toEqual({
        connection: "redis://127.0.0.1:6379/2",
        schema: "jobs",
      })
      expect(adapter().connectionOptions()).toEqual({})
    } finally {
      delete process.env.HIREFIRE_T_URL
      delete process.env.HIREFIRE_T_SCHEMA
    }
  })

  test("the macro is loaded when it is asked for", () => {
    const load = jest.fn(() => ({ jobQueueSize() {} }))
    const lazy = adapter({ macro: load })

    expect(load).not.toHaveBeenCalled()
    expect(typeof lazy.macro.jobQueueSize).toBe("function")
    expect(load).toHaveBeenCalledTimes(1)
  })
})
