/* global describe, test, expect, beforeEach, afterEach, jest */

const request = require('supertest')
const Koa = require('koa')
const sinon = require('sinon')
const HireFireMiddlewareKoa = require('../../src/middleware/koa')
const Resource = require('../../src/resource')
const { Configuration } = require('../../src/configuration')

describe('HireFireMiddlewareKoa', () => {
  let app

  beforeEach(() => {
    app = new Koa()
    app.use(HireFireMiddlewareKoa)
    app.use(ctx => { ctx.body = 'Hello' })
  })

  afterEach(() => {
    Resource.configuration = new Configuration()
    delete process.env.HIREFIRE_TOKEN
    jest.restoreAllMocks()
    sinon.restore()
  })

  test('pass through and handle request queue time process', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN'
    const now = Date.now()
    const nowTimestamp = Math.floor(now / 1000)
    const requestStartTime = String(now - 1234)
    sinon.useFakeTimers({ now })
    Resource.configuration.dyno('web')
    const start = jest.spyOn(Resource.configuration.web, 'start')
    const response = await request(app.callback())
      .get('/some/other/path')
      .set('X-Request-Start', requestStartTime)
    expect(response.status).toBe(200)
    expect(response.text).toBe('Hello')
    expect(start).toHaveBeenCalled()
    expect(Resource.configuration.web.buffer).toEqual({ [nowTimestamp]: [1234] })
  })

  test('intercept and return job queue information', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN'
    Resource.configuration.dyno('worker', () => 5)
    const response = await request(app.callback()).get('/hirefire/SOME_TOKEN/info')
    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ name: 'worker', value: 5 }])
  })
})
