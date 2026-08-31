export = Dispatcher
declare class Dispatcher {
  start(): boolean
  ensureJobQueueLoop(): void
  stop(options?: { flush?: boolean }): Promise<boolean>
  running(): boolean
}
