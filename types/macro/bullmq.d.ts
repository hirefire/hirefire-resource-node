export type BullMQOptions = {
  connection?: string | object
  connectionOptions?: object
}
export type BullMQSizeOptions = BullMQOptions & {
  skipWorking?: boolean
}
export function jobQueueLatency(...queues: string[]): Promise<never>
export function jobQueueLatency(
  ...queuesAndOptions: (string | BullMQOptions)[]
): Promise<never>
export function jobQueueSize(...queues: string[]): Promise<number>
export function jobQueueSize(
  ...queuesAndOptions: (string | BullMQSizeOptions)[]
): Promise<number>
export function jobQueueWorking(...queues: string[]): Promise<number>
export function jobQueueWorking(
  ...queuesAndOptions: (string | BullMQOptions)[]
): Promise<number>
import { JobQueueLatencyUnsupportedError } from "../errors"
export { JobQueueLatencyUnsupportedError }
