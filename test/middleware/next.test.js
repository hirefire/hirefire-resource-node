require("../support")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")
const { NextRequest, NextResponse } = require("next/server")

const { middleware, withHireFire } = require("../../src/middleware/next")

function request(headers = {}) {
  return new NextRequest("http://localhost/", { headers })
}

describe("Next.js", () => {
  let start

  beforeEach(() => {
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  describe("middleware", () => {
    test("passes through without a token", () => {
      process.env.DYNO = "web.1"
      const response = middleware(
        request({ "X-Request-Start": String(Date.now() - 1000) }),
      )
      expect(response).toBeInstanceOf(NextResponse)
      expect(response.headers.get("x-middleware-next")).toBe("1")
      expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
      expect(start).not.toHaveBeenCalled()
    })

    test("samples the web request and passes through", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const second = Math.floor(Date.now() / 1000)
      jest.spyOn(Date, "now").mockReturnValue(second * 1000)
      process.env.DYNO = "web.1"

      const response = middleware(
        request({ "X-Request-Start": String(second * 1000 - 1234) }),
      )

      expect(response).toBeInstanceOf(NextResponse)
      expect(response.headers.get("x-middleware-next")).toBe("1")
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        [second]: { sum: 1234, count: 1 },
      })
      expect(start).toHaveBeenCalled()
    })

    test("falls back to X-Queue-Start when X-Request-Start is absent", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const second = Math.floor(Date.now() / 1000)
      jest.spyOn(Date, "now").mockReturnValue(second * 1000)
      process.env.DYNO = "web.1"

      const response = middleware(
        request({ "X-Queue-Start": String(second * 1000 - 1234) }),
      )

      expect(response).toBeInstanceOf(NextResponse)
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        [second]: { sum: 1234, count: 1 },
      })
    })
  })

  describe("withHireFire", () => {
    test("calls the user middleware and returns its response", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const userResponse = NextResponse.next()
      const userMiddleware = jest.fn(() => userResponse)
      const wrapped = withHireFire(userMiddleware)
      const nextRequest = request()
      const event = { waitUntil: jest.fn() }

      const response = wrapped(nextRequest, event)

      expect(response).toBe(userResponse)
      expect(userMiddleware).toHaveBeenCalledWith(nextRequest, event)
    })

    test("samples web metrics before calling the user middleware", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const second = Math.floor(Date.now() / 1000)
      jest.spyOn(Date, "now").mockReturnValue(second * 1000)
      process.env.DYNO = "web.1"
      const userMiddleware = jest.fn(() => NextResponse.next())
      const wrapped = withHireFire(userMiddleware)

      const response = wrapped(
        request({ "X-Request-Start": String(second * 1000 - 567) }),
        { waitUntil: jest.fn() },
      )

      expect(response).toBeInstanceOf(NextResponse)
      expect(userMiddleware).toHaveBeenCalled()
      expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
        [second]: { sum: 567, count: 1 },
      })
    })
  })
})
