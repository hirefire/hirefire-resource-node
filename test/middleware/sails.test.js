require("../support")
const request = require("supertest")
const sails = require("sails")
const HireFireMiddlewareExpress = require("../../src/middleware/express")
const HireFire = require("../../src")
const Dispatcher = require("../../src/dispatcher")

let app

beforeAll((done) => {
  sails.load(
    {
      appPath: __dirname,
      log: { level: "silent" },
      globals: false,
      hooks: {
        grunt: false,
        views: false,
        blueprints: false,
        pubsub: false,
        i18n: false,
        session: false,
      },
      http: {
        middleware: {
          hirefire: HireFireMiddlewareExpress,
          order: ["hirefire", "router"],
        },
      },
    },
    (err) => {
      if (err) return done(err)
      app = sails.hooks.http.app
      done()
    },
  )
}, 30000)

afterAll((done) => {
  sails.lower(done)
})

describe("Sails", () => {
  let start

  beforeEach(() => {
    start = jest.spyOn(Dispatcher.prototype, "start").mockReturnValue(true)
  })

  test("samples the web request and starts the dispatcher", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const second = Math.floor(Date.now() / 1000)
    jest.spyOn(Date, "now").mockReturnValue(second * 1000)
    process.env.DYNO = "web.1"

    await request(app)
      .get("/")
      .set("X-Request-Start", String(second * 1000 - 1234))

    expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
      [second]: { sum: 1234, count: 1 },
    })
    expect(start).toHaveBeenCalled()
  })

  test("passes through without a token", async () => {
    process.env.DYNO = "web.1"
    await request(app)
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

    await request(app)
      .get("/")
      .set("X-Queue-Start", String(second * 1000 - 1234))

    expect(HireFire.configuration.buffer.flush().web.rqt).toEqual({
      [second]: { sum: 1234, count: 1 },
    })
  })
})
