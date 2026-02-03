const sinon = require("sinon")
const HireFire = require("../../src")
const Configuration = require("../../src/configuration")
const VERSION = require("../../src/version")

// Mock next/server module
const mockNextResponse = {
  json: jest.fn((body, options) => ({
    type: "json",
    body,
    status: options?.status,
    headers: options?.headers,
  })),
  next: jest.fn(() => ({ type: "next" })),
}

jest.mock(
  "next/server",
  () => ({
    NextResponse: mockNextResponse,
  }),
  { virtual: true },
)

const { middleware, withHireFire } = require("../../src/middleware/next")

function createMockNextRequest(pathname, headers = {}) {
  return {
    nextUrl: { pathname },
    headers: {
      get: (name) => headers[name.toLowerCase()] || null,
    },
  }
}

describe("Next.js", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    delete process.env.HIREFIRE_TOKEN
    HireFire.configuration = new Configuration()
    jest.restoreAllMocks()
    sinon.restore()
  })

  describe("middleware", () => {
    test("pass through without HIREFIRE_TOKEN", async () => {
      HireFire.configuration.dyno("web")
      HireFire.configuration.dyno("worker", () => 5)
      const start = jest.spyOn(HireFire.configuration.web, "startDispatcher")
      const request = createMockNextRequest("/", {
        "x-request-start": "1",
      })

      const response = await middleware(request)

      expect(response.type).toBe("next")
      expect(mockNextResponse.next).toHaveBeenCalled()
      expect(HireFire.configuration.web._buffer).toEqual({})
      expect(start).not.toHaveBeenCalled()
    })

    test("pass through without configuration", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const request = createMockNextRequest("/", {
        "x-request-start": "1",
      })

      const response = await middleware(request)

      expect(response.type).toBe("next")
      expect(mockNextResponse.next).toHaveBeenCalled()
    })

    test("pass through and process web configuration", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const now = Date.now()
      const nowTimestamp = Math.floor(now / 1000)
      const requestStartTime = String(now - 1234)
      sinon.useFakeTimers({ now })
      HireFire.configuration.dyno("web")
      const start = jest.spyOn(HireFire.configuration.web, "startDispatcher")
      const request = createMockNextRequest("/", {
        "x-request-start": requestStartTime,
      })

      const response = await middleware(request)

      expect(response.type).toBe("next")
      expect(mockNextResponse.next).toHaveBeenCalled()
      expect(HireFire.configuration.web._buffer).toEqual({
        [nowTimestamp]: [1234],
      })
      expect(start).toHaveBeenCalled()
    })

    test("intercept and process worker configuration", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("worker", () => 5)
      const request = createMockNextRequest("/hirefire/SOME_TOKEN/info")

      const response = await middleware(request)

      expect(response.type).toBe("json")
      expect(response.status).toBe(200)
      expect(response.headers["HireFire-Resource"]).toBe(`Node-${VERSION}`)
      expect(response.body).toEqual([{ name: "worker", value: 5 }])
    })

    test("intercept and process worker configuration with hirefire-token header", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("worker", () => 5)
      const request = createMockNextRequest("/hirefire", {
        "hirefire-token": "SOME_TOKEN",
      })

      const response = await middleware(request)

      expect(response.type).toBe("json")
      expect(response.status).toBe(200)
      expect(response.headers["HireFire-Resource"]).toBe(`Node-${VERSION}`)
      expect(response.body).toEqual([{ name: "worker", value: 5 }])
    })
  })

  describe("withHireFire", () => {
    test("calls user middleware when not a HireFire request", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const userMiddleware = jest.fn(() => ({ type: "user-response" }))
      const wrappedMiddleware = withHireFire(userMiddleware)
      const request = createMockNextRequest("/some-page")
      const event = { waitUntil: jest.fn() }

      const response = await wrappedMiddleware(request, event)

      expect(response.type).toBe("user-response")
      expect(userMiddleware).toHaveBeenCalledWith(request, event)
    })

    test("processes web metrics before calling user middleware", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      const now = Date.now()
      const nowTimestamp = Math.floor(now / 1000)
      const requestStartTime = String(now - 567)
      sinon.useFakeTimers({ now })
      HireFire.configuration.dyno("web")
      const userMiddleware = jest.fn(() => ({ type: "user-response" }))
      const wrappedMiddleware = withHireFire(userMiddleware)
      const request = createMockNextRequest("/some-page", {
        "x-request-start": requestStartTime,
      })

      const response = await wrappedMiddleware(request, {})

      expect(response.type).toBe("user-response")
      expect(userMiddleware).toHaveBeenCalled()
      expect(HireFire.configuration.web._buffer).toEqual({
        [nowTimestamp]: [567],
      })
    })

    test("intercepts HireFire info endpoint without calling user middleware", async () => {
      process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
      HireFire.configuration.dyno("worker", () => 10)
      const userMiddleware = jest.fn()
      const wrappedMiddleware = withHireFire(userMiddleware)
      const request = createMockNextRequest("/hirefire/SOME_TOKEN/info")

      const response = await wrappedMiddleware(request, {})

      expect(response.type).toBe("json")
      expect(response.status).toBe(200)
      expect(response.body).toEqual([{ name: "worker", value: 10 }])
      expect(userMiddleware).not.toHaveBeenCalled()
    })
  })
})
