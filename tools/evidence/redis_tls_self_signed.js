"use strict"

const path = require("path")
const { library, report } = require("./support")

async function main() {
  const port = process.argv[2]
  const url = `rediss://127.0.0.1:${port}/0`
  const macro = require(path.join(library, "src", "macro", "bullmq"))
  const Sampler = require(path.join(library, "src", "sampler"))
  const Configuration = require(path.join(library, "src", "configuration"))
  const options = { tls: { rejectUnauthorized: false } }
  const withOption = await macro.jobQueueSize("default", {
    connection: url,
    connectionOptions: options,
  })
  let direct
  try {
    direct = await macro.jobQueueSize("default", { connection: url })
  } catch (error) {
    direct = `rejected: ${error.message}`
  }
  const log = []
  const configuration = new Configuration()
  configuration.logger = { error: (message) => log.push(message) }
  process.env.DYNO = "worker.1"
  process.env.REDIS_URL = url
  delete process.env.REDIS_TLS_URL
  delete process.env.HIREFIRE_BULLMQ_URL
  const started = performance.now()
  await new Sampler(configuration).round(
    [
      {
        name: "worker",
        strategy: "jqs",
        adapter: "bullmq",
        queues: ["default"],
      },
    ],
    () => true,
  )
  const seconds = Math.round((performance.now() - started) / 100) / 10
  const sent = Object.keys(configuration.buffer.flush())
  report(
    "FINDING",
    "a plan sample over rediss:// to a Redis with a self-signed certificate, as Heroku Key-Value Store has, fails, and no setting of the plan path can change that",
    withOption === 0 &&
      String(direct).startsWith("rejected") &&
      sent.length === 0,
    [
      `direct call with connectionOptions.tls.rejectUnauthorized false: ${withOption}`,
      `direct call without it: ${direct}`,
      `plan entry on a dyno with REDIS_URL set to that server: ${
        sent.length
      } samples after ${seconds} seconds, log: ${log.join(" | ")}`,
    ],
  )
}

main()
