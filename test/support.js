const HireFire = require("../src")
const nock = require("nock")

const IDENTITY_ENV = [
  "HIREFIRE_SERVICE_NAME",
  "DYNO",
  "RENDER_SERVICE_NAME",
  "RENDER",
  "RENDER_CPU_COUNT",
]

// A logger that swallows everything; tests that assert on logging override it
// with jest spies.
function silentLogger() {
  return { info() {}, warn() {}, error() {}, log() {} }
}

// Equivalent of the Ruby suite's Timecop.freeze: pin Date.now to a fixed Unix
// second without faking setTimeout (so HTTP mocks and the dispatcher loop are
// unaffected). Call again to advance.
function freezeTime(seconds) {
  jest.spyOn(Date, "now").mockReturnValue(seconds * 1000)
}

async function resetState() {
  delete process.env.HIREFIRE_TOKEN
  delete process.env.HIREFIRE_DATA_URL
  delete process.env.HIREFIRE_VERBOSE
  IDENTITY_ENV.forEach((key) => delete process.env[key])
  await HireFire.reset()
  HireFire.configuration.logger = silentLogger()
}

beforeEach(async () => {
  await resetState()
})

afterEach(async () => {
  jest.restoreAllMocks()
  nock.cleanAll()
  nock.abortPendingRequests()
  await resetState()
})

module.exports = { silentLogger, freezeTime }
