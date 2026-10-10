export class MissingQueueError extends Error {
  constructor(message?: string)
}
export class JobQueueLatencyUnsupportedError extends Error {
  constructor(name: string)
}
export class MissingSamplerError extends Error {
  constructor(message: string)
}
export class DuplicateDynoError extends Error {
  constructor(message: string)
}
export function jobQueueLatencyUnsupported(name: string): never
