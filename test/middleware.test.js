const { freezeTime } = require("./support")
const HireFire = require("../src")
const Dispatcher = require("../src/dispatcher")
const {
  processRequestQueueTime,
  calculateRequestQueueTime,
} = require("../src/middleware")

describe("middleware", () => {
  let start

  beforeEach(() => {
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  describe("processRequestQueueTime", () => {
    test("collects a web sample", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("web")
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(HireFire.configuration.buffer.flush().web).toEqual({
        1700000001: [1000],
      })
    })

    test("starts the dispatcher on a web request", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("web")
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(start).toHaveBeenCalled()
    })

    test("does not start the dispatcher without a token", () => {
      HireFire.configuration.dyno("web")
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(start).not.toHaveBeenCalled()
      expect(HireFire.configuration.buffer.flush().web).toEqual({})
    })

    test("ignores an implausible request start without sampling", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("web")
      processRequestQueueTime("t=0.05")
      expect(HireFire.configuration.buffer.flush().web).toEqual({})
    })

    test("does not sample an over-the-limit queue time", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("web")
      freezeTime(1700000000)
      processRequestQueueTime("1699999000000")
      expect(HireFire.configuration.buffer.flush().web).toEqual({})
    })

    test("does not sample without a web collector", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(HireFire.configuration.buffer.flush().web).toEqual({})
    })

    test("no request-start header is a noop", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("web")
      processRequestQueueTime(undefined)
      expect(HireFire.configuration.buffer.flush().web).toEqual({})
      expect(start).not.toHaveBeenCalled()
    })

    test("logs queue metrics when enabled", () => {
      const log = jest.spyOn(console, "log").mockImplementation(() => {})
      HireFire.configuration.logQueueMetrics = true
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(log).toHaveBeenCalledWith("[hirefire:router] queue=1000ms")
    })

    test("is silent without logQueueMetrics", () => {
      const log = jest.spyOn(console, "log").mockImplementation(() => {})
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(log).not.toHaveBeenCalled()
    })

    test("an internal failure is swallowed, not raised into the request", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("web")
      const errorLog = jest
        .spyOn(HireFire.configuration.logger, "error")
        .mockImplementation(() => {})
      start.mockImplementation(() => {
        throw new Error("boom")
      })
      freezeTime(1700000001)

      expect(() => processRequestQueueTime("1700000000000")).not.toThrow()
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining("Middleware error"),
      )
    })
  })

  describe("calculateRequestQueueTime", () => {
    test("parses heroku epoch milliseconds", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000000000")).toBe(1000)
    })

    test("parses nginx epoch seconds", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000.000")).toBe(1000)
    })

    test("parses apache epoch microseconds", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000000000")).toBe(1000)
    })

    test("parses epoch nanoseconds", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000000000000000")).toBe(1000)
    })

    test("normalizes every precision variant to the same queue time", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000.250")).toBe(750)
      expect(calculateRequestQueueTime("1700000000250")).toBe(750)
      expect(calculateRequestQueueTime("1700000000250000")).toBe(750)
      expect(calculateRequestQueueTime("1700000000250000000")).toBe(750)
    })

    test("ignores an unparseable value", () => {
      expect(calculateRequestQueueTime("garbage")).toBeNull()
    })

    test("ignores an implausible value", () => {
      expect(calculateRequestQueueTime("t=0.05")).toBeNull()
    })

    test("clamps a future request start to zero", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000005000")).toBe(0)
    })

    test("clamps a future microsecond start to zero", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000005000000")).toBe(0)
    })

    test("accepts the 1e9 lower-guard boundary and rejects below it", () => {
      freezeTime(1000000001)
      expect(calculateRequestQueueTime("1000000000")).toBe(1000)
      expect(calculateRequestQueueTime("999999999")).toBeNull()
    })

    test("keeps a high-but-plausible queue time", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999950000")).toBe(50000)
    })

    test("drops an implausibly large queue time", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999000000")).toBeNull()
    })

    test("drops an over-the-limit nanosecond start", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999000000000000")).toBeNull()
    })

    test("keeps exactly the cap limit and drops one over", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999940000")).toBe(60000)
      expect(calculateRequestQueueTime("1699999939999")).toBeNull()
    })
  })
})
