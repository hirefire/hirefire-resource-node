"use strict"

const { execFileSync, spawn } = require("child_process")
const fs = require("fs")
const path = require("path")
const { root, sandboxes, nodeVersions } = require("./paths")

const CELL_TIMEOUT_MS = Number(process.env.TOOLS_CELL_TIMEOUT_MS || 900_000)
const PATCH_FROM = "exec npx --no-install jest"
const PATCH_TO = "exec npx --no-install jest ${TOOLS_JEST_ARGS:-}"

function cells() {
  return JSON.parse(
    execFileSync(path.join(root, "bin", "matrix-cells"), { encoding: "utf8" }),
  )
}

function cellId(cell) {
  const name = cell.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "")
  return `node${cell.node}-${name}`
}

function run(command, args, options) {
  return new Promise((resolve) => {
    const log = fs.openSync(options.log, "a")
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", log, log],
    })
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try {
        process.kill(-child.pid, "SIGKILL")
      } catch {}
    }, options.timeout || CELL_TIMEOUT_MS)
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      fs.closeSync(log)
      resolve({ code, signal, timedOut })
    })
  })
}

function patchRunCell(sandbox) {
  const file = path.join(sandbox, "bin", "run-cell")
  const source = fs.readFileSync(file, "utf8")
  const count = source.split(PATCH_FROM).length - 1
  if (count !== 4) {
    throw new Error(`bin/run-cell has ${count} jest lines, expected 4`)
  }
  fs.writeFileSync(file, source.split(PATCH_FROM).join(PATCH_TO))
}

function installedVersions(sandbox, cell) {
  const names =
    cell.package === "core"
      ? ["jest", "nock", "ioredis"]
      : [cell.package, "ioredis", "pg", "jest-light-runner"]
  const versions = {}
  for (const name of names) {
    const manifest = path.join(sandbox, "node_modules", name, "package.json")
    if (fs.existsSync(manifest)) {
      versions[name] = JSON.parse(fs.readFileSync(manifest, "utf8")).version
    }
  }
  return versions
}

async function prepareLane(major, slot, log) {
  const version = nodeVersions()[String(major)]
  const sandbox = path.join(sandboxes, `lane-${major}`)
  execFileSync(path.join(root, "tools", "bin", "sandbox"), [sandbox, slot], {
    stdio: "inherit",
  })
  patchRunCell(sandbox)
  const install = await run(
    "mise",
    ["exec", `node@${version}`, "--", "npm", "ci", "--silent"],
    { cwd: sandbox, env: process.env, log },
  )
  if (install.code !== 0) throw new Error(`npm ci failed on Node ${version}`)
  return { sandbox, version }
}

async function runCell(lane, cell, options) {
  const id = cellId(cell)
  const log = path.join(options.directory, "logs", `${id}.log`)
  const report = path.join(options.directory, "jest", `${id}.json`)
  fs.rmSync(log, { force: true })
  fs.rmSync(report, { force: true })
  const args = []
  if (options.coverage) {
    const coverage = path.join(options.directory, "coverage", id)
    fs.rmSync(coverage, { recursive: true, force: true })
    args.push(
      "--coverage",
      "--coverageReporters=json",
      `--coverageDirectory=${coverage}`,
    )
  }
  if (options.seed !== undefined) {
    args.push(
      "--randomize",
      `--seed=${options.seed}`,
      `--testSequencer=${path.join(
        lane.sandbox,
        "tools",
        "lib",
        "random_sequencer.js",
      )}`,
    )
  }
  if (options.extra) args.push(...options.extra)
  const guard = path.join(options.directory, "net", `${id}.txt`)
  fs.mkdirSync(path.dirname(guard), { recursive: true })
  fs.rmSync(guard, { force: true })
  args.push(
    `--setupFilesAfterEnv=${path.join(lane.sandbox, "test", "support.js")}`,
    `--setupFilesAfterEnv=${path.join(
      lane.sandbox,
      "tools",
      "lib",
      "net_guard.js",
    )}`,
  )
  args.push("--json", `--outputFile=${report}`)
  const env = {
    ...process.env,
    TOOLS_JEST_ARGS: args.join(" "),
    TOOLS_SEED: String(options.seed ?? ""),
    TOOLS_NET_GUARD: guard,
  }
  delete env.DATABASE_URL
  delete env.REDIS_URL
  const command =
    cell.package === "core"
      ? ["bin/run-cell", "core"]
      : ["bin/run-cell", cell.package, String(cell.major), cell.test]
  const started = Date.now()
  const outcome = await run(
    "mise",
    ["exec", `node@${lane.version}`, "--", ...command],
    { cwd: lane.sandbox, env, log },
  )
  const seconds = Math.round((Date.now() - started) / 100) / 10
  let totals = null
  let failed = []
  if (fs.existsSync(report)) {
    const parsed = JSON.parse(fs.readFileSync(report, "utf8"))
    totals = {
      suites: parsed.numTotalTestSuites,
      failedSuites: parsed.numFailedTestSuites,
      tests: parsed.numTotalTests,
      passed: parsed.numPassedTests,
      failed: parsed.numFailedTests,
      pending: parsed.numPendingTests,
    }
    for (const suite of parsed.testResults) {
      const file = path.relative(lane.sandbox, suite.name)
      if (suite.status === "failed" && suite.assertionResults.length === 0) {
        failed.push({ file, test: "(suite did not run)" })
      }
      for (const assertion of suite.assertionResults) {
        if (assertion.status === "failed") {
          failed.push({ file, test: assertion.fullName })
        }
      }
    }
  }
  return {
    id,
    node: lane.version,
    name: cell.name,
    package: cell.package,
    major: cell.major,
    test: cell.test,
    status: outcome.timedOut ? "timeout" : outcome.code === 0 ? "pass" : "fail",
    exit: outcome.code,
    seconds,
    seed: options.seed ?? null,
    totals,
    failed,
    installed: installedVersions(lane.sandbox, cell),
  }
}

module.exports = { cells, cellId, run, prepareLane, runCell, patchRunCell }
