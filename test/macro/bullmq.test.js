const sinon = require('sinon');
const { Queue, Worker, Job } = require('bullmq');
const { jobQueueSize } = require('../../src/macro/bullmq');

const redisURL = 'redis://127.0.0.1:6379';

describe('jobQueueSize Tests', () => {
  let defaultQueue, mailerQueue;
  let worker;
  let clock;

  beforeEach(async () => {
    defaultQueue = new Queue('default', { connection: redisURL });
    mailerQueue = new Queue('mailer', { connection: redisURL });
    await defaultQueue.obliterate({ force: true });
    await mailerQueue.obliterate({ force: true });
    clock = sinon.useFakeTimers(Date.now());
  });

  afterEach(async () => {
    clock.restore();

    // if (worker) {
    //   await worker.close();
    //   worker = null;
    // }

    await defaultQueue.close();
    await mailerQueue.close();
  });

  test('jobQueueSize without jobs', async () => {
    expect(await jobQueueSize(['default'], redisURL)).toBe(0);
  });

  test('jobQueueSize with jobs', async () => {
    await defaultQueue.add('testJob', {});
    await mailerQueue.add('testJob', {});
    expect(await jobQueueSize(['default'], redisURL)).toBe(1);
    expect(await jobQueueSize(['default', 'mailer'], redisURL)).toBe(2);
  });

  test('jobQueueSize with jobs scheduled in the past', async () => {
    await defaultQueue.add('pastScheduledJob', {}, { delay: 30_000 }); // 30 seconds delay
    expect(await jobQueueSize(['default'], redisURL)).toBe(0);
    clock.tick(30_001);
    expect(await jobQueueSize(['default'], redisURL)).toBe(1);
  });
});
