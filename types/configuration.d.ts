export = Configuration
declare class Configuration {
  static MAX_NAME_BYTES: number
  logger: Logger | null
  forceStart: boolean
  set token(value: string | null | undefined)
  get token(): string | null
  dyno(name: string): void
  dyno(name: string, sampler: () => number | Promise<number>): void
}
declare namespace Configuration {
  export { MissingSamplerError, DuplicateDynoError, Logger }
}
declare class MissingSamplerError extends Error {
  constructor(message: string)
}
declare class DuplicateDynoError extends Error {
  constructor(message: string)
}
type Logger = {
  error?: (message: string) => void
  warn?: (message: string) => void
  info?: (message: string) => void
}
