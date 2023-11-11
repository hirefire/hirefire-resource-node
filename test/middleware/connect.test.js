/* global describe, expect, test, beforeEach, afterEach, jest */

const request = require('supertest')
const connect = require('connect')
const sinon = require('sinon')
const HireFireMiddlewareConnect = require('../../src/middleware/connect')
const Resource = require('../../src/resource')
const { Configuration } = require('../../src/configuration')

describe('HireFireMiddlewareConnect', () => {
  let app

  beforeEach(() => {
    app = connect()
    app.use(HireFireMiddlewareConnect)
    app.use((req, res) => res.end('Hello'))
  })

  afterEach(() => {
    delete process.env.HIREFIRE_TOKEN
    Resource.configuration = new Configuration()
    jest.restoreAllMocks()
    sinon.restore()
  })

  test('ignore middleware when HIREFIRE_TOKEN is not set', async () => {
    Resource.configuration.dyno('web')
    Resource.configuration.dyno('worker', () => 5)
    const start = jest.spyOn(Resource.configuration.web, 'start')
    const response = await request(app)
      .get('/')
      .set('X-Request-Start', 1)
    expect(response.status).toBe(200)
    expect(response.text).toBe('Hello')
    expect(start).not.toHaveBeenCalled()
    expect(Resource.configuration.web.buffer).toEqual({})
  })

  test('pass through and handle request queue time process', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN'
    const now = Date.now()
    const nowTimestamp = Math.floor(now / 1000)
    const requestStartTime = String(now - 1234)
    sinon.useFakeTimers(now)
    Resource.configuration.dyno('web')
    const start = jest.spyOn(Resource.configuration.web, 'start')
    const response = await request(app)
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
    const response = await request(app).get('/hirefire/SOME_TOKEN/info')
    expect(response.status).toBe(200)
    expect(response.body).toEqual([{ name: 'worker', value: 5 }])
  })
})
