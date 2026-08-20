const HireFire = require("../src")
const nock = require("nock")

const IDENTITY_ENV = [
  "HIREFIRE_SERVICE_NAME",
  "DYNO",
  "RENDER_SERVICE_NAME",
  "RENDER_SERVICE_TYPE",
  "RENDER",
  "RENDER_CPU_COUNT",
]

function silentLogger() {
  return { info() {}, warn() {}, error() {}, log() {} }
}

function freezeTime(seconds) {
  jest.spyOn(Date, "now").mockReturnValue(seconds * 1000)
  jest.spyOn(performance, "now").mockReturnValue(seconds * 1000)
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
