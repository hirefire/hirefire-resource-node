const fastify = require("fastify")
const supertest = require("supertest")
const sinon = require("sinon")
const HireFireMiddlewareFastify = require("../../src/middleware/fastify")
const HireFire = require("../../src")
const Configuration = require("../../src/configuration")
const VERSION = require("../../src/version")

describe("Fastify", () => {
  let app

  beforeEach(async () => {
    app = fastify()
    app.register(HireFireMiddlewareFastify)
    app.get("/", async (request, reply) => {
      reply.send("Hello")
    })
    await app.ready()
  })

  afterEach(async () => {
    delete process.env.HIREFIRE_TOKEN
    HireFire.configuration = new Configuration()
    jest.restoreAllMocks()
    sinon.restore()
    await app.close()
  })

  test("pass through without HIREFIRE_TOKEN", async () => {
    HireFire.configuration.dyno("web")
    HireFire.configuration.dyno("worker", () => 5)
    const start = jest.spyOn(HireFire.configuration.web, "startDispatcher")
    const response = await supertest(app.server)
      .get("/")
      .set("X-Request-Start", "1")
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.web._buffer).toEqual({})
    expect(start).not.toHaveBeenCalled()
  })

  test("pass through without configuration", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const response = await supertest(app.server)
      .get("/")
      .set("X-Request-Start", "1")
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
  })

  test("pass through and process web configuration", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const now = Date.now()
    const nowTimestamp = parseInt(now / 1000)
    const requestStartTime = String(now - 1234)
    sinon.useFakeTimers({ now })
    HireFire.configuration.dyno("web")
    const start = jest.spyOn(HireFire.configuration.web, "startDispatcher")
    const response = await supertest(app.server)
      .get("/")
      .set("X-Request-Start", requestStartTime)
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.web._buffer).toEqual({
      [nowTimestamp]: [1234],
    })
    expect(start).toHaveBeenCalled()
  })

  test("intercept and process worker configuration", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    HireFire.configuration.dyno("worker", () => 5)
    const response = await supertest(app.server).get(
      "/hirefire/SOME_TOKEN/info",
    )
    expect(response.status).toBe(200)
    expect(response.headers["hirefire-resource"]).toBe(`Node-${VERSION}`)
    expect(response.body).toEqual([{ name: "worker", value: 5 }])
  })

  test("intercept and process worker configuration with hirefire-token header", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    HireFire.configuration.dyno("worker", () => 5)
    const response = await supertest(app.server)
      .get("/hirefire")
      .set("HireFire-Token", "SOME_TOKEN")
    expect(response.status).toBe(200)
    expect(response.headers["hirefire-resource"]).toBe(`Node-${VERSION}`)
    expect(response.body).toEqual([{ name: "worker", value: 5 }])
  })
})
