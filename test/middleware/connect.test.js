const request = require('supertest');
const connect = require('connect');
const sinon = require('sinon');
const HireFireMiddlewareConnect = require('../../src/middleware/connect');
const Resource = require('../../src/resource');
const { Configuration } = require('../../src/configuration');

describe('HireFireMiddlewareConnect', () => {
  let app;

  beforeEach(() => {
    app = connect();
    const middleware = new HireFireMiddlewareConnect(app);
    app.use(middleware.handle.bind(middleware));
    app.use((req, res) => res.end('Hello'));
    Resource.configuration = new Configuration();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sinon.restore();
    delete process.env.HIREFIRE_TOKEN;
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
    const now = Date.now();
    const nowTimestamp = Math.floor(now / 1000);
    const requestStartTime = String(now - 1234);
    sinon.useFakeTimers(now);
    Resource.configuration.dyno('web');
    const start = jest.spyOn(Resource.configuration.web, 'start');
    const response = await request(app)
      .get('/some/other/path')
      .set('X-Request-Start', requestStartTime);
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello');
    expect(start).toHaveBeenCalled();
    expect(Resource.configuration.web.buffer).toEqual({ [nowTimestamp]: [1234] });
  });
});
