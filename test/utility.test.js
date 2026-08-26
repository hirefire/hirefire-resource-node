const { normalizeQueues, unpack } = require("../src/utility")
const { MissingQueueError } = require("../src/errors")

describe("utility", () => {
  test("normalizeQueues trims and de-duplicates", () => {
    expect(
      normalizeQueues([" default ", "default", "mailer"], { allowEmpty: true }),
    ).toEqual(["default", "mailer"])
  })

  test("normalizeQueues requires allowEmpty", () => {
    expect(() => normalizeQueues(["default"])).toThrow()
  })

  test("normalizeQueues drops blank names", () => {
    expect(normalizeQueues(["", "  ", "ready"], { allowEmpty: true })).toEqual([
      "ready",
    ])
    expect(normalizeQueues([], { allowEmpty: true })).toEqual([])
  })

  test('normalizeQueues drops null and undefined (not the string "null")', () => {
    expect(
      normalizeQueues([null, undefined, "ready", null], { allowEmpty: true }),
    ).toEqual(["ready"])
    expect(normalizeQueues([null, null], { allowEmpty: true })).toEqual([])
    expect(() =>
      normalizeQueues([null, undefined], { allowEmpty: false }),
    ).toThrow(MissingQueueError)
  })

  test("normalizeQueues allowEmpty false raises MissingQueueError", () => {
    expect(() => normalizeQueues([], { allowEmpty: false })).toThrow(
      MissingQueueError,
    )
    expect(() => normalizeQueues(["  "], { allowEmpty: false })).toThrow(
      "No queue was specified. Please specify at least one queue.",
    )
  })

  test("normalizeQueues only-blank names return empty when allowEmpty is true", () => {
    expect(normalizeQueues(["  ", ""], { allowEmpty: true })).toEqual([])
  })

  test("unpack separates queues from a trailing options object", () => {
    expect(unpack(["a", "b", { connection: "redis://x" }])).toEqual({
      queues: ["a", "b"],
      options: { connection: "redis://x" },
    })
  })

  test("unpack flattens a nested queue array", () => {
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
