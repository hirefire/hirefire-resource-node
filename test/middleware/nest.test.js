const { Test } = require('@nestjs/testing');
const request = require('supertest');
const sinon = require('sinon');
const HireFireMiddlewareExpress = require('../../src/middleware/express');
const HireFire = require('../../src');
const { Configuration } = require('../../src/configuration');

describe('HireFireMiddlewareExpress', () => {
  let app;

  beforeEach(async () => {
    const moduleFixture = await Test.createTestingModule({
      controllers: [],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.use(HireFireMiddlewareExpress);
    await app.init();
  });

  afterEach(() => {
    delete process.env.HIREFIRE_TOKEN;
    HireFire.configuration = new Configuration();
    jest.restoreAllMocks();
    sinon.restore();
  });

  test('pass through without HIREFIRE_TOKEN', async () => {
    HireFire.configuration.dyno('web');
    HireFire.configuration.dyno('worker', () => 5);
    const start = jest.spyOn(HireFire.configuration.web, 'start');
    const response = await request(app.getHttpServer()).get('/').set('X-Request-Start', '1');
    expect(response.status).toBe(404);
    expect(HireFire.configuration.web.buffer).toEqual({});
    expect(start).not.toHaveBeenCalled();
  });

  test('pass through without configuration', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    const response = await request(app.getHttpServer()).get('/').set('X-Request-Start', '1');
    expect(response.status).toBe(404);
  });

  test('pass through and process web configuration', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    const now = Date.now();
    const nowTimestamp = parseInt(now / 1000);
    const requestStartTime = String(now - 1234);
    sinon.useFakeTimers(now);
    HireFire.configuration.dyno('web');
    const start = jest.spyOn(HireFire.configuration.web, 'start');
    const response = await request(app.getHttpServer()).get('/').set('X-Request-Start', requestStartTime);
    expect(response.status).toBe(404);
    expect(HireFire.configuration.web.buffer).toEqual({ [nowTimestamp]: [1234] });
    expect(start).toHaveBeenCalled();
  });

  test('intercept and process worker configuration', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    HireFire.configuration.dyno('worker', () => 5);
    const response = await request(app.getHttpServer()).get(`/hirefire/${process.env.HIREFIRE_TOKEN}/info`);
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ name: 'worker', value: 5 }])
  });
});
