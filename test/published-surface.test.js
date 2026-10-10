const { execFileSync } = require("child_process")
const path = require("path")
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

  test("under native ESM the default import is the client, the namespace is not, and macros and errors import by name", () => {
    const script = `
      import HireFire from "./src/index.js"
      import * as namespace from "./src/index.js"
      import { jobQueueSize, jobQueueWorking, jobQueueLatency } from "./src/macro/bullmq.js"
      import { jobQueueSize as bull } from "./src/macro/bull.js"
      import { jobQueueSize as pgBoss } from "./src/macro/pg_boss.js"
      import { MissingQueueError, MissingSamplerError } from "./src/errors.js"
      import express from "./src/middleware/express.js"
      console.log(JSON.stringify({
        client: typeof HireFire.configure,
        namespace: typeof namespace.configure,
        macros: [jobQueueSize, jobQueueWorking, jobQueueLatency, bull, pgBoss].map((macro) => typeof macro),
        errors: [MissingQueueError.name, MissingSamplerError.name],
        middleware: typeof express,
      }))
    `
    const output = execFileSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        cwd: path.join(__dirname, ".."),
        env: { PATH: process.env.PATH },
        encoding: "utf8",
      },
    )

    expect(JSON.parse(output)).toEqual({
      client: "function",
      namespace: "undefined",
      macros: ["function", "function", "function", "function", "function"],
      errors: ["MissingQueueError", "MissingSamplerError"],
      middleware: "function",
    })
  })
})
