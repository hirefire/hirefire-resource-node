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
import { JobQueueLatencyUnsupportedError } from "../errors"
export { JobQueueLatencyUnsupportedError }
