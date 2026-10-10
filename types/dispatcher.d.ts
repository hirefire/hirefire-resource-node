export = Dispatcher
declare class Dispatcher {
  start(): boolean
  stop(options?: { flush?: boolean }): Promise<boolean>
  running(): boolean
}
