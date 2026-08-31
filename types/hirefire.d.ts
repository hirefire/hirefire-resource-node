export = HireFire
declare class HireFire {
  configuration: Configuration
  configure(fn: (config: Configuration) => void): Configuration
  boot(): Configuration
  reset(): Promise<boolean>
}
import Configuration = require("./configuration")
