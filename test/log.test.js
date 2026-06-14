const safeLog = require("../src/log")

describe("safeLog", () => {
  test("calls the matching logger method with the message", () => {
    const logger = { error: jest.fn() }
    safeLog(logger, "error", "boom")
    expect(logger.error).toHaveBeenCalledWith("boom")
  })

  test("swallows a throwing logger method", () => {
    const logger = {
      error() {
        throw new Error("logger is broken")
      },
    }
    expect(() => safeLog(logger, "error", "boom")).not.toThrow()
  })

  test("skips a missing method instead of throwing", () => {
    expect(() => safeLog({}, "error", "boom")).not.toThrow()
  })

  test("tolerates a null logger", () => {
    expect(() => safeLog(null, "error", "boom")).not.toThrow()
  })
})
