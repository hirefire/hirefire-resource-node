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

  test("formatError strips URL userinfo", () => {
    const text = safeLog.formatError(
      new Error("redis://user:secret@127.0.0.1:6379/0 failed"),
    )
    expect(text).not.toMatch(/secret/)
    expect(text).toMatch(/redis:\/\/\*\*\*@127\.0\.0\.1:6379\/0/)
  })
})
