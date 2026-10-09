"use strict"

const { execFileSync } = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")
const { library, report } = require("./support")

function fakePackage(directory, name) {
  fs.mkdirSync(directory, { recursive: true })
  fs.writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
  )
  fs.writeFileSync(path.join(directory, "index.js"), "module.exports = {}\n")
}

function main() {
  const scratch = fs.mkdtempSync(
    path.join(fs.realpathSync(os.tmpdir()), "strict-install-"),
  )
  const store = path.join(scratch, "repo", "store", "hirefire-resource")
  const app = path.join(scratch, "repo", "apps", "web")
  fs.mkdirSync(store, { recursive: true })
  fs.cpSync(path.join(library, "src"), path.join(store, "src"), {
    recursive: true,
  })
  fs.copyFileSync(
    path.join(library, "package.json"),
    path.join(store, "package.json"),
  )
  fakePackage(path.join(app, "node_modules", "bullmq"), "bullmq")
  fakePackage(path.join(app, "node_modules", "ioredis"), "ioredis")
  fs.symlinkSync(store, path.join(app, "node_modules", "hirefire-resource"))
  const probe = `
    const path = require("path")
    const fs = require("fs")
    const home = fs.realpathSync("node_modules/hirefire-resource")
    const Plan = require(path.join(home, "src", "plan"))
    console.log(JSON.stringify({
      app: Boolean(require.resolve("bullmq")),
      seen: Plan.libraryLoaded("bullmq"),
      race: Plan.anyAllowlistedJobQueueLibraryLoaded(),
    }))
  `
  const result = JSON.parse(
    execFileSync(process.execPath, ["-e", probe], {
      cwd: app,
      encoding: "utf8",
    }),
  )
  fs.rmSync(scratch, { recursive: true, force: true })
  report(
    "FINDING",
    "in an install that keeps each package to its declared dependencies, the app resolves bullmq and the client does not, so the adapter counts as not loaded",
    result.app && !result.seen && !result.race,
    [
      "layout: the client in a store outside the app, linked into the app's node_modules, as pnpm does in a workspace without hoisting and Yarn does with Plug'n'Play",
      `the app resolves bullmq: ${result.app}`,
      `Plan.libraryLoaded("bullmq"): ${result.seen}`,
      `the process enters the lease race: ${result.race}`,
    ],
  )
}

main()
