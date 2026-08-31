export type BullMQOptions = {
  connection?: string | object
  connectionOptions?: object
}
export function jobQueueLatency(...args: any[]): Promise<never>
export function jobQueueSize(...queues: string[]): Promise<number>
export function jobQueueSize(
  ...queuesAndOptions: (string | BullMQOptions)[]
): Promise<number>
export function jobQueueWorking(...queues: string[]): Promise<number>
export function jobQueueWorking(
  ...queuesAndOptions: (string | BullMQOptions)[]
): Promise<number>
export function planOptions(_strategy: string, _options: any): object
export function planConnectionOptions(): object
export function supportsPlanStrategy(strategy: string | symbol): boolean
export function beforeSampleJobQueues(): true
export function afterSampleJobQueues(_token?: any): void
export function reinitAfterFork(): void
import { JobQueueLatencyUnsupportedError } from "../errors"
export { JobQueueLatencyUnsupportedError }
