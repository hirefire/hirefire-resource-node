"use strict"

const fs = require("fs")
const os = require("os")
const path = require("path")

const root = path.resolve(__dirname, "..", "..")
const results = path.join(root, "tools", "results")
const sandboxes =
  process.env.TOOLS_SANDBOXES ||
  path.join(fs.realpathSync(os.tmpdir()), "hirefire-resource-node-tools")

function nodeVersions() {
  const line = fs
    .readFileSync(path.join(root, ".tool-versions"), "utf8")
    .split("\n")
    .find((entry) => entry.startsWith("node "))
  const versions = {}
  for (const version of line.split(/\s+/).slice(1)) {
    versions[version.split(".")[0]] = version
  }
  return versions
}

function runDirectory(name) {
  const directory = path.join(results, name)
  fs.mkdirSync(directory, { recursive: true })
  return directory
}

module.exports = { root, results, sandboxes, nodeVersions, runDirectory }
