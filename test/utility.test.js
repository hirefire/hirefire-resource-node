const { normalizeQueues, presence, unpack } = require("../src/utility")
const { MissingQueueError } = require("../src/errors")

describe("utility", () => {
  test("presence trims a value and answers null for a missing or blank one", () => {
    expect(presence(" web ")).toBe("web")
    expect(presence(7)).toBe("7")
    expect(presence(0)).toBe("0")
    expect(presence("")).toBeNull()
    expect(presence(" \t\n")).toBeNull()
    expect(presence(null)).toBeNull()
    expect(presence(undefined)).toBeNull()
  })

  test("strips surrounding whitespace", () => {
    expect(
      normalizeQueues([" default ", "default", "mailer"], { allowEmpty: true }),
    ).toEqual(["default", "mailer"])
  })

  test("normalize queues requires allow empty", () => {
    expect(() => normalizeQueues(["default"])).toThrow()
  })

  test("drops blank entries", () => {
    expect(normalizeQueues(["", "  ", "ready"], { allowEmpty: true })).toEqual([
      "ready",
    ])
    expect(normalizeQueues([], { allowEmpty: true })).toEqual([])
  })

  test("drops null and undefined not the string null", () => {
    expect(
      normalizeQueues([null, undefined, "ready", null], { allowEmpty: true }),
    ).toEqual(["ready"])
    expect(normalizeQueues([null, null], { allowEmpty: true })).toEqual([])
    expect(() =>
      normalizeQueues([null, undefined], { allowEmpty: false }),
    ).toThrow(MissingQueueError)
  })

  test("empty queues disallowed raises", () => {
    expect(() => normalizeQueues([], { allowEmpty: false })).toThrow(
      MissingQueueError,
    )
    expect(() => normalizeQueues(["  "], { allowEmpty: false })).toThrow(
      "No queue was specified. Please specify at least one queue.",
    )
  })

  test("only blank entries return empty when empty is allowed", () => {
    expect(normalizeQueues(["  ", ""], { allowEmpty: true })).toEqual([])
  })

  test("unpack separates queues from a trailing options object", () => {
    expect(unpack(["a", "b", { connection: "redis://x" }])).toEqual({
      queues: ["a", "b"],
      options: { connection: "redis://x" },
    })
  })

  test("flattens nested queue lists", () => {
    expect(
      unpack([["default", "mailer"], { connection: "redis://x" }]),
    ).toEqual({
      queues: ["default", "mailer"],
      options: { connection: "redis://x" },
    })
  })

  test("unpack keeps all arguments when options are omitted", () => {
    expect(unpack(["default", ["mailer"]])).toEqual({
      queues: ["default", "mailer"],
      options: {},
    })
  })
})
