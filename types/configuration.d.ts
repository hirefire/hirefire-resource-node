export = Configuration
declare class Configuration {
  logger: Logger | null
  http: object | null
  jobQueues: object
  set token(value: string | null | undefined)
  get token(): string | null
  dyno(name: string): void
  dyno(name: string, sampler: () => number | Promise<number>): void
  get buffer(): Buffer
  get dispatcher(): Dispatcher
  get httpName(): string | null
  get httpSource(): object | null
  markHttpActive(): void
  get rqtEnabled(): boolean
  get rqtLiveness(): boolean
  activeCpuSources(): object[]
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
import Buffer = require("./buffer")
import Dispatcher = require("./dispatcher")
