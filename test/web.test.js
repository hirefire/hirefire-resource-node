const { Web, DispatchError } = require("../src/web")
const Configuration = require("../src/configuration")
const nock = require("nock")
const VERSION = require("../src/version")

describe("Web", () => {
  let web
  let configuration
  let infoSpy
  let errorSpy

  beforeEach(() => {
    configuration = new Configuration()
    web = new Web(configuration)
    infoSpy = jest
      .spyOn(configuration.logger, "info")
      .mockImplementation(() => {})
    errorSpy = jest
      .spyOn(configuration.logger, "error")
      .mockImplementation(() => {})
    process.env.HIREFIRE_TOKEN = "8ab101e2-51da-49bc-beba-111dec49a287"
  })

  afterEach(() => {
    infoSpy.mockRestore()
    errorSpy.mockRestore()
    nock.abortPendingRequests()
    nock.cleanAll()
    jest.clearAllMocks()
    jest.restoreAllMocks()
    delete process.env.HIREFIRE_TOKEN
  })

  test("starts and stops correctly", async () => {
    expect(web.dispatcherRunning()).toBeFalsy()
    expect(await web.startDispatcher()).toBeTruthy()
    expect(web.dispatcherRunning()).toBeTruthy()
    expect(await web.startDispatcher()).toBeFalsy()
    expect(infoSpy).toHaveBeenCalledWith(
      "[HireFire] Starting web metrics dispatcher.",
    )
    web.addToBuffer(1)
    expect(await web.stopDispatcher()).toBeTruthy()
    expect(web.dispatcherRunning()).toBeFalsy()
    expect(await web.stopDispatcher()).toBeFalsy()
    expect(web._buffer).toEqual({})
    expect(infoSpy).toHaveBeenCalledWith(
      "[HireFire] Web metrics dispatcher stopped.",
    )
  })

  test("buffer addition", async () => {
    await web.addToBuffer(1)
    const bufferContents = await web._flushBuffer()
    expect(Object.keys(bufferContents).length).toBeGreaterThan(0)
    expect(bufferContents[Object.keys(bufferContents)[0]]).toEqual([1])
  })

  test("buffer flushing", async () => {
    await web.addToBuffer(2)
    await web._flushBuffer()
    const bufferContentsAfterFlush = await web._flushBuffer()
    expect(bufferContentsAfterFlush).toEqual({})
  })

  test("successful dispatch post", async () => {
    nock("https://logdrain.hirefire.io")
      .matchHeader("HireFire-Resource", `Node-${VERSION}`)
      .post("/")
      .reply(200)
    await web.addToBuffer(5)
    await web._dispatchBuffer()
    expect(errorSpy).not.toHaveBeenCalled()
  })

  test("dispatch with unexpected response code", async () => {
    nock("https://logdrain.hirefire.io").post("/").reply(404)
    await web.addToBuffer(5)
    await web._dispatchBuffer()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Unexpected response code 404."),
    )
  })

  test("dispatch with generic exception", async () => {
    nock("https://logdrain.hirefire.io")
      .post("/")
      .replyWithError("Some generic error")
    await web.addToBuffer(8)
    await web._dispatchBuffer()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Some generic error"),
    )
  })

  test("dispatch with server error", async () => {
    nock("https://logdrain.hirefire.io").post("/").reply(500)
    await web.addToBuffer(4)
    await web._dispatchBuffer()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Server responded with 500 status."),
    )
  })

  test("dispatch with timeout", async () => {
    nock("https://logdrain.hirefire.io")
      .post("/")
      .delayConnection(6000)
      .reply(200, "")
    await web.addToBuffer(5)
    await web._dispatchBuffer()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Request timed out."),
    )
  })

  test("dispatch with ETIMEDOUT error", async () => {
    nock("https://logdrain.hirefire.io")
      .post("/")
      .replyWithError({ code: "ETIMEDOUT" })
    await web.addToBuffer(9)
    await web._dispatchBuffer()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Request timed out."),
    )
  })

  test("dispatch with network error", async () => {
    nock("https://logdrain.hirefire.io").post("/").replyWithError({
      message: "Network error occurred",
      code: "ENETUNREACH",
    })
    await web.addToBuffer(6)
    await web._dispatchBuffer()
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Network error occurred"),
    )
  })

  test("buffer repopulation after dispatch failure", async () => {
    nock("https://logdrain.hirefire.io").post("/").reply(500)
    await web.addToBuffer(7)
    await web._dispatchBuffer()
    const bufferContentsAfterFail = await web._flushBuffer()
    expect(
      bufferContentsAfterFail[Object.keys(bufferContentsAfterFail)[0]],
    ).toEqual([7])
  })

  test("buffer TTL discards old entries", async () => {
    nock("https://logdrain.hirefire.io").post("/").reply(500)
    const timestamp1 = new Date(2000, 0, 1, 0, 0, 0).getTime()
    const timestamp1Key = Math.floor(timestamp1 / 1000)
    jest.spyOn(Date, "now").mockImplementation(() => timestamp1)
    await web.addToBuffer(5)
    expect(web._buffer).toEqual({ [timestamp1Key]: [5] })
    const timestamp2 = new Date(2000, 0, 1, 0, 0, 30).getTime()
    const timestamp2Key = Math.floor(timestamp2 / 1000)
    Date.now.mockImplementation(() => timestamp2)
    await web.addToBuffer(10)
    expect(web._buffer).toEqual({ [timestamp1Key]: [5], [timestamp2Key]: [10] })
    Date.now.mockImplementation(() => new Date(2000, 0, 1, 0, 1, 0).getTime())
    await web._dispatchBuffer()
    expect(web._buffer).toEqual({ [timestamp1Key]: [5], [timestamp2Key]: [10] })
    Date.now.mockImplementation(() => new Date(2000, 0, 1, 0, 1, 1).getTime())
    await web._dispatchBuffer()
    expect(web._buffer).toEqual({ [timestamp2Key]: [10] })
  })

  test("adjust parameters based on response headers", async () => {
    const newInterval = 10
    const newTimeout = 10
    const newTTL = 120
    nock("https://logdrain.hirefire.io")
      .matchHeader("HireFire-Resource", `Node-${VERSION}`)
      .post("/")
      .reply(200, "", {
        "HireFire-Resource-Dispatcher-Interval": newInterval,
        "HireFire-Resource-Dispatcher-Timeout": newTimeout,
        "HireFire-Resource-Buffer-TTL": newTTL,
      })
    await web.addToBuffer(5)
    await web._dispatchBuffer()
    expect(web._dispatchInterval).toEqual(newInterval)
    expect(web._dispatchTimeout).toEqual(newTimeout)
    expect(web._bufferTTL).toEqual(newTTL)
  })

  test("throws error when HIREFIRE_TOKEN is missing", async () => {
    delete process.env.HIREFIRE_TOKEN
    const buffer = {}

    await expect(web._submitBuffer(buffer)).rejects.toThrowError(
      new DispatchError(
        "The HIREFIRE_TOKEN environment variable is not set. " +
          "Unable to submit Request Queue Time metric data. " +
          "The HIREFIRE_TOKEN can be found in the HireFire Web UI " +
          "in the web dyno manager settings.",
      ),
    )
  })

  test("uses HIREFIRE_DISPATCH_URL when set", async () => {
    const dispatchUrl = "https://custom.dispatch.url"
    process.env.HIREFIRE_DISPATCH_URL = dispatchUrl

    nock(dispatchUrl).post("/").reply(200)

    await web.addToBuffer(5)
    await web._dispatchBuffer()

    expect(nock.isDone()).toBeTruthy()

    delete process.env.HIREFIRE_DISPATCH_URL
  })
})
