const {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  jobQueueLatencyUnsupported,
} = require("../src/errors")

describe("errors", () => {
  test("MissingQueueError uses its default message and name", () => {
    const error = new MissingQueueError()

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(MissingQueueError)
    expect(error.name).toBe("MissingQueueError")
    expect(error.message).toBe(
      "No queue was specified. Please specify at least one queue.",
    )
  })

  test("JobQueueLatencyUnsupportedError identifies the adapter", () => {
    const error = new JobQueueLatencyUnsupportedError("BullMQ")

    expect(error).toBeInstanceOf(Error)
    expect(error).toBeInstanceOf(JobQueueLatencyUnsupportedError)
    expect(error.name).toBe("JobQueueLatencyUnsupportedError")
    expect(error.message).toBe(
      "BullMQ currently does not support job queue latency measurements.",
    )
  })

  test("jobQueueLatencyUnsupported throws the typed error", () => {
    expect(() => jobQueueLatencyUnsupported("Bull")).toThrow(
      JobQueueLatencyUnsupportedError,
    )
    expect(() => jobQueueLatencyUnsupported("Bull")).toThrow(
      "Bull currently does not support job queue latency measurements.",
    )
  })
})
