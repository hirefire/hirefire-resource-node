const {
  MissingQueueError,
  JobQueueLatencyUnsupportedError,
  MissingSamplerError,
  DuplicateDynoError,
  jobQueueLatencyUnsupported,
} = require("../src/errors")
const Configuration = require("../src/configuration")

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

  test.each([
    ["MissingSamplerError", MissingSamplerError],
    ["DuplicateDynoError", DuplicateDynoError],
  ])(
    "%s carries its name and message, and the configuration exposes the same class",
    (name, ErrorClass) => {
      const error = new ErrorClass("what went wrong")

      expect(error).toBeInstanceOf(Error)
      expect(error.name).toBe(name)
      expect(error.message).toBe("what went wrong")
      expect(Configuration[name]).toBe(ErrorClass)
    },
  )

  test("the configuration raises the two errors of the errors module", () => {
    const configuration = new Configuration()
    configuration.dyno("worker", () => 1)

    expect(() => configuration.dyno("worker", () => 2)).toThrow(
      DuplicateDynoError,
    )
    expect(() => configuration.dyno("mailer")).toThrow(MissingSamplerError)
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
