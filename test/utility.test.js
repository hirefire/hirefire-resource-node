const { normalizeQueues, unpack } = require("../src/utility")

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

  test("unpack separates queues from a trailing options object", () => {
    expect(unpack(["a", "b", { connection: "redis://x" }])).toEqual({
      queues: ["a", "b"],
      options: { connection: "redis://x" },
    })
  })
})
