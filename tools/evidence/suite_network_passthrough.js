"use strict"

const net = require("net")
const path = require("path")
const { library, report } = require("./support")

async function main() {
  const alive = setInterval(() => {}, 1000)
  const attempts = []
  const connect = net.Socket.prototype.connect
  net.Socket.prototype.connect = function recordedConnect(...args) {
    const first = Array.isArray(args[0]) ? args[0][0] : args[0]
    const options = first && typeof first === "object" ? first : {}
    if (options.host && options.host !== "127.0.0.1") {
      attempts.push(`${options.host}:${options.port}`)
      options.lookup = () => {}
    }
    return connect.apply(this, args)
  }

  const nock = require(require.resolve("nock", { paths: [library] }))
  const { Client } = require(path.join(library, "src", "client"))
  delete process.env.HIREFIRE_DATA_URL
  nock("https://data.hirefire.io").post("/metrics/ingest").reply(200)
  const client = new Client({ token: "evidence-token" }, { timeout: 0.3 })

  const first = await client.submitSamples("[]")
  const afterFirst = attempts.length
  let unmatched
  try {
    await client.submitSamples("[]")
    unmatched = "answered"
  } catch (error) {
    unmatched = error.message.split("\n")[0]
  }
  const afterUnmatched = attempts.length

  nock.cleanAll()
  let second
  try {
    await client.submitSamples("[]")
    second = "answered"
  } catch (error) {
    second = error.message
  }
  const afterSecond = attempts.length

  nock.disableNetConnect()
  let third
  try {
    await client.submitSamples("[]")
    third = "answered"
  } catch (error) {
    third = error.message.split("\n")[0]
  }
  await client.close()
  nock.cleanAll()
  nock.enableNetConnect()
  net.Socket.prototype.connect = connect
  clearInterval(alive)

  report(
    "FINDING",
    "after nock.cleanAll(), which the suite runs after every test, a request to the data host is sent to the real host",
    first.statusCode === 200 &&
      afterFirst === 0 &&
      afterUnmatched === 0 &&
      afterSecond === 1 &&
      attempts.length === 1,
    [
      `request with an interceptor: status ${first.statusCode}, connection attempts ${afterFirst}`,
      `request past the interceptor, in the same test: ${unmatched.slice(
        0,
        60,
      )}, connection attempts ${afterUnmatched}`,
      `request after nock.cleanAll(): ${second}, connection attempts to ${
        attempts[0] || "nothing"
      }: ${afterSecond}`,
      `request after nock.disableNetConnect(): ${third.slice(
        0,
        70,
      )}, connection attempts ${attempts.length}`,
    ],
  )
}

main()
