export type BullOptions = {
  connection?: string | object
  connectionOptions?: object
}
export type BullSizeOptions = BullOptions & {
  skipWorking?: boolean
}
export function jobQueueLatency(...queues: string[]): Promise<never>
export function jobQueueLatency(
  ...queuesAndOptions: (string | BullOptions)[]
): Promise<never>
export function jobQueueSize(...queues: string[]): Promise<number>
export function jobQueueSize(
  ...queuesAndOptions: (string | BullSizeOptions)[]
): Promise<number>
export function jobQueueWorking(...queues: string[]): Promise<number>
export function jobQueueWorking(
  ...queuesAndOptions: (string | BullOptions)[]
): Promise<number>
export function planOptions(strategy: string, options: any): object
export function planConnectionOptions(): object
export function supportsPlanStrategy(strategy: string | symbol): boolean
export function queuesRequired(): boolean
export function beforeSampleJobQueues(): true
export function afterSampleJobQueues(_token?: any): void
export function reinitAfterFork(): void
import { JobQueueLatencyUnsupportedError } from "../errors"
export { JobQueueLatencyUnsupportedError }
