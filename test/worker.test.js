const { Worker } = require('../src/worker');

describe('Worker', () => {
  test('setup and methods', () => {
    const worker = new Worker('worker', () => 1 + 1);
    expect(worker.name).toBe('worker');
    expect(worker.call()).resolves.toBe(2);
  });
});
