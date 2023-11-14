/* global describe, test, expect, beforeEach, afterEach, jest */

const supertest = require('supertest');
const sinon = require('sinon');
const Sails = require('sails').Sails;
const HireFireMiddlewareExpress = require('../../src/middleware/express');
const HireFire = require('../../src');
const { Configuration } = require('../../src/configuration');

describe('HireFireMiddlewareExpress with Sails', () => {
  let sailsApp, request;

  beforeEach((done) => {
    sailsApp = new Sails();
    sailsApp.lift({
      log: { level: 'silent' },
      hooks: { grunt: false, blueprints: false, orm: false, pubsub: false },
      routes: {
        'GET /': (req, res, next) => {
          HireFireMiddlewareExpress(req, res, next);
          res.status(200).send('Hello');
        },
        'GET /hirefire/:token/info': (req, res, next) => {
          HireFireMiddlewareExpress(req, res, next);
        }
      }
    }, (err) => {
      if (err) { return done(err); }
      request = supertest(sailsApp.hooks.http.app);
      done();
    });
  });

  afterEach((done) => {
    delete process.env.HIREFIRE_TOKEN;
    HireFire.configuration = new Configuration();
    jest.restoreAllMocks();
    sinon.restore();
    sailsApp.lower(done);
  });

  test('pass through without HIREFIRE_TOKEN', async () => {
    HireFire.configuration.dyno('web');
    HireFire.configuration.dyno('worker', () => 5);
    const start = jest.spyOn(HireFire.configuration.web, 'start');
    const response = await request.get('/').set('X-Request-Start', 1);
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello');
    expect(HireFire.configuration.web.buffer).toEqual({});
    expect(start).not.toHaveBeenCalled();
  });

  test('pass through without configuration', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    const response = await request.get('/').set('X-Request-Start', 1);
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello');
  });

  test('pass through and process web configuration', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    const now = Date.now();
    const nowTimestamp = parseInt(now / 1000);
    const requestStartTime = String(now - 1234);
    sinon.useFakeTimers({ now });
    HireFire.configuration.dyno('web');
    const start = jest.spyOn(HireFire.configuration.web, 'start');
    const response = await request.get('/').set('X-Request-Start', requestStartTime);
    expect(response.status).toBe(200);
    expect(response.text).toBe('Hello');
    expect(HireFire.configuration.web.buffer).toEqual({ [nowTimestamp]: [1234] });
    expect(start).toHaveBeenCalled();
  });

  test('intercept and process worker configuration', async () => {
    process.env.HIREFIRE_TOKEN = 'SOME_TOKEN';
    HireFire.configuration.dyno('worker', () => 5);
    const response = await request.get('/hirefire/SOME_TOKEN/info');
    expect(response.status).toBe(200);
    expect(response.body).toEqual([{ name: 'worker', value: 5 }]);
  });
});
