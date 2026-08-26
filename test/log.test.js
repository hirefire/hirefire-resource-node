const safeLog = require("../src/log")

describe("safeLog", () => {
  test("delegates to the logger", () => {
    const logger = { error: jest.fn() }
    safeLog(logger, "error", "boom")
    expect(logger.error).toHaveBeenCalledWith("boom")
  })

  test("swallows a raising logger", () => {
    const logger = {
      error() {
        throw new Error("logger is broken")
      },
    }
    expect(() => safeLog(logger, "error", "boom")).not.toThrow()
  })

  test("skips a logger that does not respond to the level", () => {
    expect(() => safeLog({}, "error", "boom")).not.toThrow()
  })

  test("safe with null logger", () => {
    expect(() => safeLog(null, "error", "boom")).not.toThrow()
  })
})
