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
  })
})
