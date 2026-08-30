require("reflect-metadata")
const request = require("supertest")
const { NestFactory } = require("@nestjs/core")
const { Module } = require("@nestjs/common")
const HireFireMiddlewareExpress = require("../../src/middleware/express")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")

class AppModule {}
Module({})(AppModule)

describe("Nest", () => {
  let app
  let start

  beforeEach(async () => {
    jest.restoreAllMocks()
    delete process.env.HIREFIRE_TOKEN
    delete process.env.DYNO
    await HireFire.reset()
    app = await NestFactory.create(AppModule, { logger: false })
    app.use(HireFireMiddlewareExpress)
    await app.init()
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  afterEach(async () => {
    await app.close()
    jest.restoreAllMocks()
  })

  test("samples the web request and starts the dispatcher", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    process.env.DYNO = "web.1"

    await request(app.getHttpServer())
      .get("/")
      .set("X-Request-Start", String(second * 1000 - 1234))

    expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
      [second]: { sum: 1234, count: 1 },
    })
    expect(start).toHaveBeenCalled()
  })

  test("passes through without a token", async () => {
    process.env.DYNO = "web.1"
    await request(app.getHttpServer())
      .get("/")
      .set("X-Request-Start", String(Date.now() - 1000))
    expect(HireFire.configuration.buffer.flush().web).toBeUndefined()
    expect(start).not.toHaveBeenCalled()
  })

  test("falls back to X-Queue-Start when X-Request-Start is absent", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    process.env.DYNO = "web.1"

    await request(app.getHttpServer())
      .get("/")
      .set("X-Queue-Start", String(second * 1000 - 1234))

    expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
      [second]: { sum: 1234, count: 1 },
    })
  })
})
