require("../support")
const request = require("supertest")
const Koa = require("koa")
const HireFireMiddlewareKoa = require("../../src/middleware/koa")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")

describe("Koa", () => {
  let app
  let start

  beforeEach(() => {
    app = new Koa()
    app.use(HireFireMiddlewareKoa)
    app.use((ctx) => {
      ctx.body = "Hello"
    })
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  test("passes through without a token", async () => {
    process.env.DYNO = "web.1"
    const response = await request(app.callback())
      .get("/")
      .set("X-Request-Start", String(Date.now() - 1000))
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
  })

  test("samples the web request and starts the dispatcher", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    process.env.DYNO = "web.1"

    const response = await request(app.callback())
      .get("/")
      .set("X-Request-Start", String(second * 1000 - 1234))

    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
      [second]: { sum: 1234, count: 1 },
    })
    expect(start).toHaveBeenCalled()
  })

  test("falls back to X-Queue-Start when X-Request-Start is absent", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    process.env.DYNO = "web.1"

    const response = await request(app.callback())
      .get("/")
      .set("X-Queue-Start", String(second * 1000 - 1234))

    expect(response.status).toBe(200)
    expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
      [second]: { sum: 1234, count: 1 },
    })
  })
})
