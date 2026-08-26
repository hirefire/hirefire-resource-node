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

    test("absent X-Request-Start falls back to X-Queue-Start", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime(undefined, "1700000000000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("present X-Request-Start wins over a present X-Queue-Start", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("1700000000000", "1699999996000")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("blank X-Request-Start falls back to X-Queue-Start", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      process.env.DYNO = "web.1"
      freezeTime(1700000001)
      processRequestQueueTime("", "1700000000000")
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
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        1700000001: { sum: 1000, count: 1 },
      })
    })

    test("a raising httpSource.sample does not start the dispatcher", () => {
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

    test("a raising logger still records rqt", () => {
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

    test("clamps a future microsecond start to zero", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000005000000")).toBe(0)
    })

    test("a nanosecond start beyond 60000 ms returns null", () => {
      freezeTime(1700000000)
      expect(calculateRequestQueueTime("1699999000000000000")).toBeNull()
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

    test("normalizes t-prefix milliseconds", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("t=1700000000250")).toBe(750)
    })

    test("reads a folded duplicate header", () => {
      freezeTime(1700000001)
      expect(calculateRequestQueueTime("1700000000000, 1700000000500")).toBe(
        1000,
      )
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
