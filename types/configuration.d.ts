export = Configuration
declare class Configuration {
  static MAX_NAME_BYTES: number
  logger: Logger | null
  set token(value: string | null | undefined)
  get token(): string | null
  dyno(name: string): void
  dyno(name: string, sampler: () => number | Promise<number>): void
}
declare namespace Configuration {
  export { MissingSamplerError, DuplicateDynoError, Logger }
}
import { MissingSamplerError, DuplicateDynoError } from "./errors"
type Logger = {
  error?: (message: string) => void
  warn?: (message: string) => void
  info?: (message: string) => void
}
