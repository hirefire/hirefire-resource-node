const { normalizeQueues, unpack } = require("../src/utility")
const { MissingQueueError } = require("../src/errors")

describe("utility", () => {
  test("normalizeQueues trims and de-duplicates", () => {
    expect(normalizeQueues([" default ", "default", "mailer"])).toEqual([
      "default",
      "mailer",
    ])
  })

  test("normalizeQueues drops blank names", () => {
    expect(normalizeQueues(["", "  ", "ready"])).toEqual(["ready"])
    expect(normalizeQueues([])).toEqual([])
  })

  test('normalizeQueues drops null and undefined (not the string "null")', () => {
    expect(normalizeQueues([null, undefined, "ready", null])).toEqual(["ready"])
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

  test("unpack separates queues from a trailing options object", () => {
    expect(unpack(["a", "b", { connection: "redis://x" }])).toEqual({
      queues: ["a", "b"],
      options: { connection: "redis://x" },
    })
  })
})
