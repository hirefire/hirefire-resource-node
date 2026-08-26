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
    test("collects web sample", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("always on samples without a http source", () => {
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

    test("falls back to x queue start when request start is whitespace", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("   ", "1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("reads x queue start when request start is absent", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime(undefined, "1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("prefers x request start over x queue start", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000", "1699999996000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("falls back to x queue start when request start is blank", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("", "1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("starts dispatcher on web request", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(start).toHaveBeenCalled()
      expect(ensure).toHaveBeenCalled()
    })

    test("swallows throwing header extraction", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      const throwing = {
        toString() {
          throw new Error("header boom")
        },
      }
      expect(() => processRequestQueueTime(throwing)).not.toThrow()
      expect(() =>
        processRequestQueueTime(
          () => {
            throw new Error("getter boom")
          },
          () => "1700000000000",
        ),
      ).not.toThrow()
    })

    test("does not start dispatcher without token", () => {
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(start).not.toHaveBeenCalled()
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    })

    test("ignores implausible request start", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      processRequestQueueTime("t=0.05")
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    })

    test("does not sample an over the limit queue time", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000000)
      processRequestQueueTime("1699999000000")
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    })

    test("does not sample without identity or explicit http name", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000")
      expect(Object.keys(HireFire.configuration.buffer.flush())).toHaveLength(0)
      expect(start).toHaveBeenCalled()
    })

    test("no request start header is a noop", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      processRequestQueueTime(undefined)
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
      expect(start).not.toHaveBeenCalled()
    })

    test("an internal failure does not break the request", () => {
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
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("a raising http source sample does not start the dispatcher", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      const source = HireFire.configuration.httpSource
      jest.spyOn(source, "sample").mockImplementation(() => {
        throw new Error("sample boom")
      })
      freezeTime(1700000001)
      expect(() => processRequestQueueTime("1700000000000")).not.toThrow()
      expect(start).not.toHaveBeenCalled()
      expect(ensure).not.toHaveBeenCalled()
      expect(HireFire.configuration.dispatcher.running()).toBe(false)
    })

    test("a raising logger does not break the request", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      HireFire.configuration.logger = {
        info() {},
        warn() {},
        error() {
          throw new Error("logger down")
        },
      }
      start.mockImplementation(() => {
        throw new Error("boom")
      })
      freezeTime(1700000001)
      expect(() => processRequestQueueTime("1700000000000")).not.toThrow()
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
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

    test("ignores non finite request start headers", () => {
      expect(calculateRequestQueueTime("Infinity")).toBeNull()
      expect(calculateRequestQueueTime("NaN")).toBeNull()
    })

    test("ignores unparseable request start", () => {
      expect(calculateRequestQueueTime("garbage")).toBeNull()
    })

    test("ignores implausible value", () => {
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

    test("drops an over the limit nanosecond start", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999000000000000")).toBeNull()
    })

    test("lower guard boundary accepts 1e9 and rejects below", () => {
      freezeTime(1000000001)
      expect(calculateRequestQueueTime("1000000000")).toBe(1000)
      expect(calculateRequestQueueTime("999999999")).toBeNull()
    })

    test("cap boundary keeps exactly the limit and drops one over", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999940000")).toBe(60000)
      expect(calculateRequestQueueTime("1699999939999")).toBeNull()
    })

    test("rounds exact half up", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000000000.5")).toBe(999)
    })

    test("rounds a fractional millisecond remainder", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000.2506")).toBe(749)
    })

    test("rounds a fractional nanosecond remainder", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000000250600000")).toBe(749)
    })

    test("drops a negative request start", () => {
      expect(calculateRequestQueueTime("-1700000000250")).toBeNull()
    })

    test("t prefix milliseconds normalizes", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000250")).toBe(750)
    })

    test("proxy folded request start uses the leading timestamp", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000000000, 1700000000500")).toBe(
        1000,
      )
    })
  })

  test("marks http active for tokened request without platform web role", () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    process.env.HIREFIRE_SERVICE_NAME = "api"
    expect(HireFire.configuration.rqtEnabled).toBe(false)
    freezeTime(1700000001)
    processRequestQueueTime("1700000000000")
    expect(HireFire.configuration.rqtEnabled).toBe(true)
    const data = HireFire.configuration.buffer.flush()
    expect(data.api.rqt).toBeDefined()
  })

  test("does not mark http active without token", () => {
    process.env.HIREFIRE_SERVICE_NAME = "api"
    freezeTime(1700000001)
    processRequestQueueTime("1700000000000")
    expect(HireFire.configuration.rqtEnabled).toBe(false)
    expect(Object.keys(HireFire.configuration.buffer.flush())).toHaveLength(0)
  })
})
