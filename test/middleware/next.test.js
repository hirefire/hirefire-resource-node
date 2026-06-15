require("../support")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")
const { NextResponse } = require("next/server")

const { middleware, withHireFire } = require("../../src/middleware/next")

function mockRequest(pathname, headers = {}) {
  return {
    nextUrl: { pathname },
    headers: { get: (name) => headers[name.toLowerCase()] || null },
  }
}

describe("Next.js", () => {
  let start

  beforeEach(() => {
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  describe("middleware", () => {
    test("passes through without a token", () => {
      HireFire.configuration.dyno("web")
      const response = middleware(
        mockRequest("/", { "x-request-start": String(Date.now() - 1000) }),
      )
      expect(response).toBeInstanceOf(NextResponse)
      expect(response.headers.get("x-middleware-next")).toBe("1")
      expect(HireFire.configuration.buffer.flush().web).toEqual({})
      expect(start).not.toHaveBeenCalled()
    })

    test("samples the web request and passes through", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const second = Math.floor(Date.now() / 1000)
      jest.spyOn(Date, "now").mockReturnValue(second * 1000)
      HireFire.configuration.dyno("web")

      const response = middleware(
        mockRequest("/", { "x-request-start": String(second * 1000 - 1234) }),
      )

      expect(response).toBeInstanceOf(NextResponse)
      expect(response.headers.get("x-middleware-next")).toBe("1")
      expect(HireFire.configuration.buffer.flush().web).toEqual({
        [second]: [1234],
      })
      expect(start).toHaveBeenCalled()
    })

    test("the former info path now passes through", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("worker", () => 5)
      const response = middleware(mockRequest("/hirefire/SOME_TOKEN/info"))
      // Passes through (NextResponse.next) rather than intercepting with JSON.
      expect(response).toBeInstanceOf(NextResponse)
      expect(response.headers.get("x-middleware-next")).toBe("1")
    })
  })

  describe("withHireFire", () => {
    test("calls the user middleware", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const userMiddleware = jest.fn(() => ({ type: "user-response" }))
      const wrapped = withHireFire(userMiddleware)
      const request = mockRequest("/some-page")
      const event = { waitUntil: jest.fn() }

      const response = wrapped(request, event)

      expect(response.type).toBe("user-response")
      expect(userMiddleware).toHaveBeenCalledWith(request, event)
    })

    test("samples web metrics before calling the user middleware", () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const second = Math.floor(Date.now() / 1000)
      jest.spyOn(Date, "now").mockReturnValue(second * 1000)
      HireFire.configuration.dyno("web")
      const userMiddleware = jest.fn(() => ({ type: "user-response" }))
      const wrapped = withHireFire(userMiddleware)

      const response = wrapped(
        mockRequest("/some-page", {
          "x-request-start": String(second * 1000 - 567),
        }),
        {},
      )

      expect(response.type).toBe("user-response")
      expect(HireFire.configuration.buffer.flush().web).toEqual({
        [second]: [567],
      })
    })
  })
})
