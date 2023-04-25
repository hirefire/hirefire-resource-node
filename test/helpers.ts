const nock = require("nock");

export const PLATFORM = "render";
export const TOKEN = "u4quBFgM72qun74EwashWv6Ll5TzhBVktVmicoWoXla";
export const BASE_TIMESTAMP = 946684800;
export let CONSOLE: jest.SpyInstance;

export function travelTo (datetime: string) {
  jest.useFakeTimers({
    doNotFake: [
      // 'Date',
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout'
    ]
  })
  jest.setSystemTime(new Date(datetime));
}

export function travel (distance: number) {
  jest.setSystemTime(new Date(Date.now() + distance))
}

export function setup () {
  jest.restoreAllMocks();
  travelTo("2000")
  nock.cleanAll();
  nock.disableNetConnect();
  CONSOLE = jest.spyOn(console, "log");
}
