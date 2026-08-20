const { freezeTime } = require("./support")
const HireFire = require("../src")
const Dispatcher = require("../src/dispatcher")
const {
  processRequestQueueTime,
  calculateRequestQueueTime,
  presentHeader,
} = require("../src/middleware")

describe("middleware", () => {
  let start
  let ensure

  beforeEach(() => {
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
    ensure = jest
      .spyOn(Dispatcher.prototype, "ensureJobQueueLoop")
      .mockImplementation(() => {})
  })

  describe("processRequestQueueTime", () => {
    test("collects a web sample", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("always on without web collector under dyno web.1", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
      expect(start).toHaveBeenCalled()
      expect(ensure).toHaveBeenCalled()
    })

    test("traffic arm with service name", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.HIREFIRE_SERVICE_NAME = "api"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(HireFire.configuration.buffer.flush().api.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("whitespace request start falls back to queue start", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("   ", "1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("starts the dispatcher on a web request", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(start).toHaveBeenCalled()
      expect(ensure).toHaveBeenCalled()
    })

    test("does not start the dispatcher without a token", () => {
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(start).not.toHaveBeenCalled()
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    })

    test("ignores an implausible request start without sampling", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      processRequestQueueTime("t=0.05")
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    })

    test("does not sample an over-the-limit queue time", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000000)
      processRequestQueueTime("1699999000000")
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    })

    test("no identity no sample when required", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(Object.keys(HireFire.configuration.buffer.flush())).toHaveLength(0)
      expect(start).toHaveBeenCalled()
    })

    test("no request-start header is a noop", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      processRequestQueueTime(undefined)
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
      expect(start).not.toHaveBeenCalled()
    })

    test("logQueueMetrics emits router line without token", () => {
      delete process.env.HIREFIRE_TOKEN
      HireFire.configuration.token = null
      const log = jest.spyOn(console, "log").mockImplementation(() => {})
      HireFire.configuration.logQueueMetrics = true
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(log).toHaveBeenCalledWith("[hirefire:router] queue=1000ms")
    })

    test("is silent without logQueueMetrics", () => {
      delete process.env.HIREFIRE_TOKEN
      HireFire.configuration.token = null
      const log = jest.spyOn(console, "log").mockImplementation(() => {})
      HireFire.configuration.logQueueMetrics = false
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(log).not.toHaveBeenCalled()
    })

    test("an internal failure is swallowed, not raised into the request", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
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

  describe("presentHeader", () => {
    test("strips and treats whitespace as absent", () => {
      expect(presentHeader("  x  ")).toBe("x")
      expect(presentHeader("   ")).toBeNull()
      expect(presentHeader(null)).toBeNull()
    })
  })

  describe("calculateRequestQueueTime", () => {
    test("normalizes every precision variant to the same queue time", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000.250")).toBe(750)
      expect(calculateRequestQueueTime("1700000000250")).toBe(750)
      expect(calculateRequestQueueTime("1700000000250000")).toBe(750)
      expect(calculateRequestQueueTime("1700000000250000000")).toBe(750)
    })

    test("ignores non finite values", () => {
      expect(calculateRequestQueueTime("Infinity")).toBeNull()
      expect(calculateRequestQueueTime("NaN")).toBeNull()
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

    test("accepts the 1e9 lower-guard boundary and rejects below it", () => {
      freezeTime(1000000001)
      expect(calculateRequestQueueTime("1000000000")).toBe(1000)
      expect(calculateRequestQueueTime("999999999")).toBeNull()
    })

    test("keeps exactly the cap limit and drops one over", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999940000")).toBe(60000)
      expect(calculateRequestQueueTime("1699999939999")).toBeNull()
    })
  })

  test("tokened traffic without platform web role marks http active and enables rqt", () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    process.env.HIREFIRE_SERVICE_NAME = "api"
    expect(HireFire.configuration.rqtEnabled).toBe(false)
    freezeTime(1700000001)
    processRequestQueueTime("1700000000000")
    expect(HireFire.configuration.rqtEnabled).toBe(true)
    const data = HireFire.configuration.buffer.flush()
    expect(data.api.rqt).toBeDefined()
  })

  test("request without token does not mark http active", () => {
    process.env.HIREFIRE_SERVICE_NAME = "api"
    freezeTime(1700000001)
    processRequestQueueTime("1700000000000")
    expect(HireFire.configuration.rqtEnabled).toBe(false)
    expect(Object.keys(HireFire.configuration.buffer.flush())).toHaveLength(0)
  })
})
