const { capture, freezeTime } = require("../support")
const HireFire = require("../../src")
const FailureLog = require("../../src/dispatcher/failure_log")

describe("FailureLog", () => {
  let lines
  let failureLog

  beforeEach(() => {
    lines = capture()
    failureLog = new FailureLog("Dispatch", HireFire.configuration)
  })

  function failAt(seconds) {
    freezeTime(1000 + seconds)
    failureLog.failed(new RangeError("down"))
  }

  test("the first failure is logged without a count", () => {
    failAt(0)

    expect(lines).toEqual([
      ["error", "[HireFire] Dispatch error: RangeError: down"],
    ])
    expect(failureLog.count).toBe(1)
  })

  test("a failure inside the interval is counted and not logged", () => {
    expect(FailureLog.INTERVAL).toBe(60)
    failAt(0)
    failAt(59.9)

    expect(lines).toHaveLength(1)
    expect(failureLog.count).toBe(2)
  })

  test("a failure at the interval is logged with the count", () => {
    failAt(0)
    failAt(60)

    expect(lines[1]).toEqual([
      "error",
      "[HireFire] Dispatch error: RangeError: down (2 failed attempts in a row)",
    ])
  })

  test("the interval starts again with each line that is logged", () => {
    failAt(0)
    failAt(60)
    failAt(119.9)
    expect(lines).toHaveLength(2)

    failAt(120)
    expect(lines[2][1]).toBe(
      "[HireFire] Dispatch error: RangeError: down (4 failed attempts in a row)",
    )
  })

  test("a recovery after one failure logs nothing and after two logs the count", () => {
    failAt(0)
    failureLog.recovered()
    expect(lines).toHaveLength(1)
    expect(failureLog.count).toBe(0)

    failAt(1)
    failAt(2)
    failureLog.recovered()

    expect(lines[lines.length - 1]).toEqual([
      "info",
      "[HireFire] Dispatch recovered after 2 failed attempts.",
    ])
    expect(failureLog.count).toBe(0)
  })

  test("a recovery without a failure logs nothing", () => {
    failureLog.recovered()

    expect(lines).toEqual([])
  })

  test("the first failure after a recovery is logged at once", () => {
    failAt(0)
    failureLog.recovered()
    failAt(1)

    expect(lines.map(([, message]) => message)).toEqual([
      "[HireFire] Dispatch error: RangeError: down",
      "[HireFire] Dispatch error: RangeError: down",
    ])
  })

  test("a recorded message is logged as given and limited like a failure", () => {
    freezeTime(1000)
    failureLog.record("Dropped a payload.")
    failureLog.record("Dropped a payload.")
    freezeTime(1060)
    failureLog.record("Dropped a payload.")

    expect(lines).toEqual([
      ["error", "[HireFire] Dropped a payload."],
      ["error", "[HireFire] Dropped a payload. (3 failed attempts in a row)"],
    ])
  })

  test("a failure keeps the credentials of a URL out of the log", () => {
    failureLog.failed(new Error("redis://user:secret@localhost:6379/0 down"))

    expect(lines[0][1]).toBe(
      "[HireFire] Dispatch error: Error: redis://***@localhost:6379/0 down",
    )
  })
})
