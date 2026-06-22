require("../support")
const supertest = require("supertest")
const fastify = require("fastify")
const HireFireMiddlewareFastify = require("../../src/middleware/fastify")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")

describe("Fastify", () => {
  let app
  let start

  beforeEach(async () => {
    app = fastify()
    app.register(HireFireMiddlewareFastify)
    app.get("/", async (request, reply) => reply.send("Hello"))
    await app.ready()
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  afterEach(async () => {
    await app.close()
  })

  test("passes through without a token", async () => {
    HireFire.configuration.dyno("web")
    const response = await supertest(app.server)
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

    const response = await supertest(app.server)
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

    const response = await supertest(app.server)
      .get("/")
      .set("X-Queue-Start", String(second * 1000 - 1234))

    expect(response.status).toBe(200)
    expect(HireFire.configuration.buffer.flush().web).toEqual({
      [second]: [1234],
    })
  })
})
