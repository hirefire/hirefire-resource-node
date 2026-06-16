require("../support")
const request = require("supertest")
const connect = require("connect")
const HireFireMiddlewareConnect = require("../../src/middleware/connect")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")

describe("Connect", () => {
  let app
  let start

  beforeEach(() => {
    app = connect()
    app.use(HireFireMiddlewareConnect)
    app.use((req, res) => res.end("Hello"))
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  test("passes through without a token", async () => {
    HireFire.configuration.dyno("web")
    const response = await request(app)
      .get("/")
      .set("X-Request-Start", String(Date.now() - 1000))
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.buffer.flush().web).toEqual({})
    expect(start).not.toHaveBeenCalled()
  })

  test("samples the web request and starts the dispatcher", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    HireFire.configuration.dyno("web")

    const response = await request(app)
      .get("/")
      .set("X-Request-Start", String(second * 1000 - 1234))

    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.buffer.flush().web).toEqual({
      [second]: [1234],
    })
    expect(start).toHaveBeenCalled()
  })

  test("falls back to X-Queue-Start when X-Request-Start is absent", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    HireFire.configuration.dyno("web")

    const response = await request(app)
      .get("/")
      .set("X-Queue-Start", String(second * 1000 - 1234))

    expect(response.status).toBe(200)
    expect(HireFire.configuration.buffer.flush().web).toEqual({
      [second]: [1234],
    })
  })

  test("the former info path now passes through to the app", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    HireFire.configuration.dyno("worker", () => 5)
    const response = await request(app).get("/hirefire/SOME_TOKEN/info")
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
  })
})
