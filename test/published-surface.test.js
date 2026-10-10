const bull = require("../src/macro/bull")
const bullmq = require("../src/macro/bullmq")
const pgBoss = require("../src/macro/pg_boss")

describe("first-party adapter published surface", () => {
  test.each([
    ["bull", bull, ["JobQueueLatencyUnsupportedError"]],
    ["bullmq", bullmq, ["JobQueueLatencyUnsupportedError"]],
    ["pg_boss", pgBoss, []],
  ])("%s exports its three macros and no plan hook", (_name, macro, errors) => {
    expect(Object.keys(macro).sort()).toEqual(
      [...errors, "jobQueueLatency", "jobQueueSize", "jobQueueWorking"].sort(),
    )
  })
})
