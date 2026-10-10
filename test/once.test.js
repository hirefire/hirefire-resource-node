const HireFire = require("../src")
const Once = require("../src/once")

describe("Once", () => {
  let lines
  let once

  function capture() {
    const captured = []
    HireFire.configuration.logger = {
      info: (message) => captured.push(["info", message]),
      warn: (message) => captured.push(["warn", message]),
      error: (message) => captured.push(["error", message]),
    }
    return captured
  }

  beforeEach(() => {
    lines = capture()
    once = new Once(HireFire.configuration)
  })

  test("a line is logged the first time and not again", () => {
    for (let i = 0; i < 3; i++) {
      once.log("warn", "cpu_unresolved", null, "no identity")
    }

    expect(lines).toEqual([["warn", "no identity"]])
  })

  test("each key of a kind and each kind gets its own line", () => {
    once.log("error", "unknown_adapter", "worker", "first")
    once.log("error", "unknown_adapter", "mailer", "second")
    once.log("error", "unloaded_adapter", "worker", "third")
    once.log("error", "unknown_adapter", "worker\0bullmq", "fourth")
    once.log("error", "unknown_adapter", "worker", "fifth")

    expect(lines.map(([, message]) => message)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
    ])
  })

  test("the line is logged at the level given", () => {
    once.log("info", "a", null, "informed")
    once.log("error", "b", null, "failed")

    expect(lines).toEqual([
      ["info", "informed"],
      ["error", "failed"],
    ])
  })

  test("a kind remembers its last 256 keys", () => {
    expect(Once.LIMIT).toBe(256)
    for (let index = 1; index <= Once.LIMIT; index++) {
      once.log("warn", "queue", index, "line")
    }
    once.log("warn", "queue", 1, "line")
    expect(lines).toHaveLength(Once.LIMIT)

    once.log("warn", "queue", Once.LIMIT + 1, "line")
    once.log("warn", "queue", 2, "line")
    once.log("warn", "queue", 1, "line")
    expect(lines).toHaveLength(Once.LIMIT + 2)
  })

  test("the logger in use when the line is due receives it", () => {
    const later = capture()

    once.log("warn", "swapped", null, "to the new logger")

    expect(lines).toEqual([])
    expect(later).toEqual([["warn", "to the new logger"]])
  })

  test("a logger that throws does not throw into the caller", () => {
    HireFire.configuration.logger = {
      warn() {
        throw new Error("closed stream")
      },
    }

    expect(() => once.log("warn", "broken", null, "lost")).not.toThrow()
  })
})
