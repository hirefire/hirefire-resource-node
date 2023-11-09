const { Web } = require('../src/web');
const nock = require('nock');

describe('Web', () => {
  let web;
  let infoSpy;
  let warnSpy;

  beforeEach(() => {
    web = new Web();
    infoSpy = jest.spyOn(web.logger, 'info').mockImplementation(() => {});
    warnSpy = jest.spyOn(web.logger, 'warn').mockImplementation(() => {});
    process.env.HIREFIRE_TOKEN = "8ab101e2-51da-49bc-beba-111dec49a287";
  });

  afterEach(() => {
    infoSpy.mockRestore();
    warnSpy.mockRestore();
    nock.abortPendingRequests();
    nock.cleanAll();
    jest.clearAllMocks();
    jest.restoreAllMocks();
    delete process.env.HIREFIRE_TOKEN
  });

  test('starts and stops correctly', async () => {
    expect(web.running).toBeFalsy();
    await web.start();
    expect(web.running).toBeTruthy();
    expect(infoSpy).toHaveBeenCalledWith("[HireFire] Starting web metrics dispatcher.");
    await web.stop();
    expect(web.running).toBeFalsy();
    expect(infoSpy).toHaveBeenCalledWith("[HireFire] Web metrics dispatcher stopped.");
  });

  test('buffer addition', async () => {
    await web.addToBuffer(1);
    const bufferContents = await web.flush();
    expect(Object.keys(bufferContents).length).toBeGreaterThan(0);
    expect(bufferContents[Object.keys(bufferContents)[0]]).toEqual([1]);
  });

  test('buffer flushing', async () => {
    await web.addToBuffer(2);
    await web.flush();
    const bufferContentsAfterFlush = await web.flush();
    expect(bufferContentsAfterFlush).toEqual({});
  });

  test('successful dispatch post', async () => {
    nock('https://logdrain.hirefire.io').post('/').reply(200);
    await web.addToBuffer(5);
    await web.dispatch();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test('dispatch post with unexpected response code', async () => {
    nock('https://logdrain.hirefire.io').post('/').reply(404);
    await web.addToBuffer(5);
    await web.dispatch();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unexpected response code 404."));
  });

  test('dispatch post with generic exception', async () => {
    nock('https://logdrain.hirefire.io').post('/').replyWithError('Some generic error');
    await web.addToBuffer(8);
    await web.dispatch();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Some generic error"));
  });

  test('dispatch post with server error', async () => {
    nock('https://logdrain.hirefire.io').post('/').reply(500);
    await web.addToBuffer(4);
    await web.dispatch();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Server responded with 500 status."));
  });

  test('dispatch post with timeout', async () => {
    let n = nock('https://logdrain.hirefire.io')
      .post('/')
      .delayConnection(6000)
      .reply(200, "");
    await web.addToBuffer(5);
    await web.dispatch();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Request timed out."));
  });

  test('dispatch post with network error', async () => {
    nock('https://logdrain.hirefire.io').post('/').replyWithError({ message: 'Network error occurred', code: 'ENETUNREACH' });
    await web.addToBuffer(6);
    await web.dispatch();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Network error occurred"));
  });

  test('dispatch post with missing token', async () => {
    delete process.env.HIREFIRE_TOKEN;
    await web.addToBuffer(7);
    await web.dispatch()
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("HIREFIRE_TOKEN environment variable is not set."));
  });

  test('buffer repopulation after dispatch failure', async () => {
    nock('https://logdrain.hirefire.io').post('/').reply(500);
    await web.addToBuffer(7);
    await web.dispatch();
    const bufferContentsAfterFail = await web.flush();
    expect(bufferContentsAfterFail[Object.keys(bufferContentsAfterFail)[0]]).toEqual([7]);
  });

  test('buffer TTL discards old entries', async () => {
    nock('https://logdrain.hirefire.io').post('/').reply(500);

    const now = Date.now();
    const expired = now - (web.BUFFER_TTL + 10) * 1000;

    jest.spyOn(Date, 'now').mockImplementation(() => now);
    await web.addToBuffer(7);

    Date.now.mockImplementation(() => expired);
    await web.addToBuffer(8);

    Date.now.mockImplementation(() => now);
    await web.dispatch();

    const bufferContentsAfterFail = await web.flush();
    const timestamp = Math.floor(now/1000);
    expect(bufferContentsAfterFail).toEqual({[timestamp]: [7]});
  });
});
