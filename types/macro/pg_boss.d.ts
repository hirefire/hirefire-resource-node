export type Queryable = {
  query: (...args: any[]) => any
}
export type PgBossOptions = {
  connection?: string | Queryable
  connectionOptions?: object
  schema?: string
  pool?: Queryable
}
export type PgBossSizeOptions = PgBossOptions & {
  skipWorking?: boolean
}
export function jobQueueLatency(...queues: string[]): Promise<number>
export function jobQueueLatency(
  ...queuesAndOptions: (string | PgBossOptions)[]
): Promise<number>
export function jobQueueSize(...queues: string[]): Promise<number>
export function jobQueueSize(
  ...queuesAndOptions: (string | PgBossSizeOptions)[]
): Promise<number>
export function jobQueueWorking(...queues: string[]): Promise<number>
export function jobQueueWorking(
  ...queuesAndOptions: (string | PgBossOptions)[]
): Promise<number>
export function planOptions(strategy: string, options: any): object
export function planConnectionOptions(): object
export function supportsPlanStrategy(strategy: string | symbol): boolean
export function queuesRequired(): boolean
export function beforeSampleJobQueues(): any | null | Promise<any | null>
export function afterSampleJobQueues(_token?: any): void | Promise<void>
export function reinitAfterFork(): void | Promise<void>
