const request = require('supertest');
const express = require('express');
const sinon = require('sinon');
const HireFireMiddlewareExpress = require('../../src/middleware/express');
const Resource = require('../../src/resource');
const {Configuration} = require('../../src/configuration');

describe('HireFireMiddlewareExpress', () => {
  let app;

  beforeEach(() => {
    app = express();
    const middleware = new HireFireMiddlewareExpress(app);
    app.use(middleware.handle);
    app.use((req, res) => res.status(200).send('Hello'));
    Resource.configuration = new Configuration()
  });

  test('info path for development', async () => {
    Resource.configuration.dyno('worker', () => 5);
    const response = await request(app).get('/hirefire/development/info');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ name: 'worker', value: 5 }]);
  });

  test('info path for token', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    Resource.configuration.dyno('worker', () => 5);
    const response = await request(app).get('/hirefire/SOME_TOKEN/info');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ name: 'worker', value: 5 }]);
  });

  test('non-intercepted path', async () => {
    const response = await request(app).get('/some/other/path');
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello');
  });

  test('process request queue time with dyno web', async () => {
    const now = Date.now()
    const nowTimestamp = parseInt(now/1000)
    const requestStartTime = String(now-1234);
    const start = jest.fn();
    sinon.useFakeTimers({now: now});
    Resource.configuration.dyno('web');
    Resource.configuration.web.start = start;
    const response = await request(app)
          .get('/some/other/path')
          .set('X-Request-Start', requestStartTime);
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello');
    expect(start).toHaveBeenCalled();
    expect(Resource.configuration.web.buffer).toEqual({[nowTimestamp]: [1234]});
  });
});
