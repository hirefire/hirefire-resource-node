export class MissingQueueError extends Error {
  constructor(message?: string)
}
export class JobQueueLatencyUnsupportedError extends Error {
  constructor(name: string)
}
export function jobQueueLatencyUnsupported(name: string): never
