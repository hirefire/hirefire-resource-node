/* global describe, test, expect, beforeEach, afterEach, jest */

const request = require("supertest")
const express = require("express")
const sinon = require("sinon")
const HireFireMiddlewareExpress = require("../../src/middleware/express")
const HireFire = require("../../src")
const { Configuration } = require("../../src/configuration")
const pkg = require("../../package.json")

describe("Express", () => {
  let app

  beforeEach(() => {
    app = express()
    app.use(HireFireMiddlewareExpress)
    app.use((req, res) => res.status(200).send("Hello"))
  })

  afterEach(() => {
    delete process.env.HIREFIRE_TOKEN
    HireFire.configuration = new Configuration()
    jest.restoreAllMocks()
    sinon.restore()
  })

  test("pass through without HIREFIRE_TOKEN", async () => {
    HireFire.configuration.dyno("web")
    HireFire.configuration.dyno("worker", () => 5)
    const start = jest.spyOn(HireFire.configuration.web, "start")
    const response = await request(app).get("/").set("X-Request-Start", 1)
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.web.buffer).toEqual({})
    expect(start).not.toHaveBeenCalled()
  })

  test("pass through without configuration", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    const response = await request(app).get("/").set("X-Request-Start", 1)
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
    const start = jest.spyOn(HireFire.configuration.web, "start")
    const response = await request(app)
      .get("/")
      .set("X-Request-Start", requestStartTime)
    expect(response.status).toBe(200)
    expect(response.text).toBe("Hello")
    expect(HireFire.configuration.web.buffer).toEqual({
      [nowTimestamp]: [1234],
    })
    expect(start).toHaveBeenCalled()
  })

  test("intercept and process worker configuration", async () => {
    process.env.HIREFIRE_TOKEN = "SOME_TOKEN"
    HireFire.configuration.dyno("worker", () => 5)
    const response = await request(app).get("/hirefire/SOME_TOKEN/info")
    expect(response.status).toBe(200)
    expect(response.headers["hirefire-resource"]).toBe(`Node-${pkg.version}`)
    expect(response.body).toEqual([{ name: "worker", value: 5 }])
  })
})
