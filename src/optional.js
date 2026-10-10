const { createRequire } = require("module")
const path = require("path")

function load(name) {
  return (origin(name) ?? createRequire(__filename))(name)
}

function installed(name) {
  return origin(name) !== null
}

function origin(name) {
  for (const file of [__filename, path.join(process.cwd(), "index.js")]) {
    const from = createRequire(file)
    try {
      from.resolve(name)
      return from
    } catch {}
  }
  return null
}

module.exports = { load, installed }
