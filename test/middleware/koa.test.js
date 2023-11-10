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
    const middleware = new HireFireMiddlewareKoa()
    app.use(middleware.handle)
    app.use(ctx => {
      ctx.body = 'Hello'
    })
    Resource.configuration = new Configuration()
  })

  afterEach(() => {
    jest.restoreAllMocks()
    sinon.restore()
    delete process.env.HIREFIRE_TOKEN
  })

  test('info path for development', async () => {
    Resource.configuration.dyno('worker', () => 5)
    const response = await request(app.callback()).get('/hirefire/development/info')
    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ name: 'worker', value: 5 }])
  })

  test('info path for token', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN'
    Resource.configuration.dyno('worker', () => 5)
    const response = await request(app.callback()).get('/hirefire/SOME_TOKEN/info')
    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ name: 'worker', value: 5 }])
  })

  test('non-intercepted path', async () => {
    const response = await request(app.callback()).get('/some/other/path')
    expect(response.status).toBe(200)
    expect(response.text).toBe('Hello')
  })

  test('process request queue time with dyno web', async () => {
    const now = Date.now()
    const nowTimestamp = Math.floor(now / 1000)
    const requestStartTime = String(now - 1234) // 1234 milliseconds earlier
    sinon.useFakeTimers({ now })

    Resource.configuration.dyno('web')
    const startSpy = jest.spyOn(Resource.configuration.web, 'start')
    const addToBufferSpy = jest.spyOn(Resource.configuration.web, 'addToBuffer')

    const response = await request(app.callback())
      .get('/some/other/path')
      .set('X-Request-Start', requestStartTime)

    expect(response.status).toBe(200)
    expect(response.text).toBe('Hello')
    expect(startSpy).toHaveBeenCalled()
    expect(addToBufferSpy).toHaveBeenCalledWith(1234)
    expect(Resource.configuration.web.buffer).toEqual({ [nowTimestamp]: [1234] })

    sinon.restore()
    jest.restoreAllMocks()
  })
})
