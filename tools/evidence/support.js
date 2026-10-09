"use strict"

const path = require("path")
const { FakeServer, grantHeaders } = require("../lib/fake_server")

const library = process.env.TOOLS_LIBRARY || path.resolve(__dirname, "..", "..")
const IDENTITY_ENV = [
  "DYNO",
  "HIREFIRE_SERVICE_NAME",
  "RENDER_SERVICE_NAME",
  "RENDER_SERVICE_TYPE",
  "RENDER",
  "RENDER_CPU_COUNT",
  "HIREFIRE_VERBOSE",
]

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function grant(plan, frequency = 1, extra = {}) {
  return {
    status: 200,
    headers: { ...grantHeaders(frequency), ...extra },
    body: JSON.stringify(plan),
  }
}

async function boot({ env = {}, handler, configure } = {}) {
  const server = await new FakeServer({ handler }).listen()
  for (const key of IDENTITY_ENV) delete process.env[key]
  Object.assign(
    process.env,
    { HIREFIRE_TOKEN: "evidence-token", HIREFIRE_DATA_URL: server.url },
    env,
  )
  const log = []
  const HireFire = require(path.join(library, "src"))
  const logger = {
    info: (message) => log.push(`I ${message}`),
    warn: (message) => log.push(`W ${message}`),
    error: (message) => log.push(`E ${message}`),
  }
  HireFire.configure((config) => {
    config.logger = logger
    if (configure) configure(config)
  })
  const paths = (wanted) =>
    server.requests.filter((request) => request.path === wanted)
  return {
    HireFire,
    server,
    log,
    ingests: () => paths("/metrics/ingest"),
    leases: () => paths("/metrics/lease"),
    async stop() {
      await HireFire.configuration.dispatcher.stop({ flush: false })
      await server.stop()
    },
  }
}

function report(kind, claim, reproduced, lines) {
  console.log(`${kind}: ${claim}`)
  for (const line of lines) console.log(`  ${line}`)
  console.log(reproduced ? "RESULT: holds" : "RESULT: does not hold")
  process.exitCode = reproduced ? 0 : 1
}

module.exports = { library, sleep, grant, boot, report }
