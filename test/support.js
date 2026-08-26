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

const originalReset = HireFire.reset.bind(HireFire)
HireFire.reset = async function resetWithSilentLogger(...args) {
  const result = await originalReset(...args)
  HireFire.configuration.logger = silentLogger()
  return result
}

async function resetState() {
  delete process.env.HIREFIRE_TOKEN
  delete process.env.HIREFIRE_DATA_URL
  delete process.env.HIREFIRE_VERBOSE
  IDENTITY_ENV.forEach((key) => delete process.env[key])
  await HireFire.reset()
}

const testPath = expect.getState().testPath ?? ""
const skipGlobalReset =
  /[\\/]test[\\/]macro[\\/]/.test(testPath) &&
  !/-plan\.test\.js$/.test(testPath)

async function closeOpenHandles() {
  const dispatcher = HireFire.configuration._dispatcher
  if (dispatcher) {
    try {
      await dispatcher.stop({ flush: false })
    } catch {}
  }
  jest.restoreAllMocks()
  nock.cleanAll()
  nock.abortPendingRequests()
}

if (!skipGlobalReset) {
  beforeEach(async () => {
    await resetState()
  })
}

afterEach(async () => {
  await closeOpenHandles()
  await resetState()
})

module.exports = { silentLogger, freezeTime }
