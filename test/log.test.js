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

  test.each([
    [
      "connect failed for redis://:abc/def@host:6379",
      "Error: connect failed for redis://***@host:6379",
    ],
    [
      "redis://user:p@ss@host:6379/0 refused",
      "Error: redis://***@host:6379/0 refused",
    ],
    [
      "tried postgres://u:p@a/db and redis://:q@b:1",
      "Error: tried postgres://***@a/db and redis://***@b:1",
    ],
    [
      "no credentials in redis://host:6379/0 here",
      "Error: no credentials in redis://host:6379/0 here",
    ],
    ["mail user@example.com", "Error: mail user@example.com"],
  ])("formatError turns %j into %j", (message, expected) => {
    expect(safeLog.formatError(new Error(message))).toBe(expected)
  })

  test("formatError names the class of an error and prints any other value as text", () => {
    expect(safeLog.formatError(new TypeError("bad"))).toBe("TypeError: bad")
    expect(safeLog.formatError("redis://a:b@c down")).toBe("redis://***@c down")
    expect(safeLog.formatError(undefined)).toBe("undefined")
  })

  test("formatError does not throw for a value that cannot be shown", () => {
    const unreadable = {
      toString() {
        throw new Error("no text")
      },
    }
    const error = new Error("hidden")
    Object.defineProperty(error, "message", {
      get() {
        throw new Error("no message")
      },
    })

    expect(safeLog.formatError(unreadable)).toBe(
      "an error that cannot be shown (object)",
    )
    expect(safeLog.formatError(Object.create(null))).toBe(
      "an error that cannot be shown (object)",
    )
    expect(safeLog.formatError(error)).toBe(
      "an error that cannot be shown (object)",
    )
  })

  test.each([
    [undefined, false],
    ["", false],
    ["0", false],
    ["false", false],
    ["FALSE", false],
    ["no", false],
    ["No", false],
    ["1", true],
    ["true", true],
    ["yes", true],
    ["anything", true],
  ])("verbose with HIREFIRE_VERBOSE set to %j is %j", (value, expected) => {
    if (value === undefined) delete process.env.HIREFIRE_VERBOSE
    else process.env.HIREFIRE_VERBOSE = value

    expect(safeLog.verbose()).toBe(expected)
  })
})
