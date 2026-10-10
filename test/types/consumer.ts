import HireFire = require("../../types")
import Configuration = require("../../types/configuration")
import errors = require("../../types/errors")

const configuration = HireFire.configure((config) => {
  config.token = "token"
  config.forceStart = false
  config.logger = { info() {}, warn() {}, error() {} }
  config.dyno("worker", async () => 1)
})
const token: string | null = configuration.token
void token
void HireFire.boot()
void HireFire.reset()
void Configuration.MAX_NAME_BYTES
void Configuration.MissingSamplerError
void Configuration.DuplicateDynoError
void errors.jobQueueLatencyUnsupported
void errors.MissingQueueError
void errors.JobQueueLatencyUnsupportedError
