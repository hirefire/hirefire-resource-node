export type PgBossOptions = {
  connection?: string | object
  connectionOptions?: object
  schema?: string
  pool?: object
}
export function jobQueueLatency(...queues: string[]): Promise<number>
export function jobQueueLatency(
  ...queuesAndOptions: (string | PgBossOptions)[]
): Promise<number>
export function jobQueueSize(...queues: string[]): Promise<number>
export function jobQueueSize(
  ...queuesAndOptions: (string | PgBossOptions)[]
): Promise<number>
export function jobQueueWorking(...args: any[]): Promise<number>
export function planOptions(_strategy: string, _options: any): object
export function planConnectionOptions(): object
export function supportsPlanStrategy(strategy: string | symbol): boolean
export function beforeSampleJobQueues(): any | null | Promise<any | null>
export function afterSampleJobQueues(_token?: any): void | Promise<void>
export function reinitAfterFork(): void | Promise<void>
