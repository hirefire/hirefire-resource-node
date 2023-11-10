const { Configuration, InvalidDynoNameError, MissingDynoFnError } = require('../src/configuration');
const { Web } = require('../src/web');
const { Worker } = require('../src/worker');

describe('Configuration', () => {
  let configuration;

  beforeEach(() => {
    configuration = new Configuration();
  });

  test('default logger points to console', () => {
    expect(configuration.logger).toBe(console);
  });

  test('can set logger', () => {
    const customLogger = console;
    configuration.logger = customLogger;
    expect(configuration.logger).toBe(customLogger);
  });

  test('web defaults to null', () => {
    expect(configuration.web).toBeNull();
  });

  test('workers default to empty array', () => {
    expect(configuration.workers).toEqual([]);
  });

  test('dyno configures web correctly', () => {
    configuration.dyno('web');
    expect(configuration.web).toBeInstanceOf(Web);
  });

  test('dyno adds function configuration to workers', () => {
    const workerFn = () => 1 + 1;
    configuration.dyno('worker', workerFn);
    expect(configuration.workers.length).toBe(1);
    expect(configuration.workers[0].name).toBe('worker');
    expect(configuration.workers[0].fn()).toBe(2); // Assuming Worker class uses `fn` to store the function
  });

  test('dyno raises error for invalid dyno name', () => {
    expect(() => {
      configuration.dyno('_invalid');
    }).toThrow(InvalidDynoNameError);
  });

  test('dyno raises error for missing dyno function', () => {
    expect(() => {
      configuration.dyno('worker');
    }).toThrow(MissingDynoFnError);
  });
});
