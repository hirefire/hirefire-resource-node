"use strict"

const fs = require("fs")
const net = require("net")
const path = require("path")

const record = process.env.TOOLS_NET_GUARD
const LOCAL = new Set(["127.0.0.1", "::1", "localhost"])
const root = path.resolve(__dirname, "..", "..")

function current() {
  try {
    const state = expect.getState()
    const file = path.relative(root, state.testPath || "")
    return `${file}: ${state.currentTestName || "(outside a test)"}`
  } catch {
    return "(outside a test)"
  }
}

function describeRequest(args) {
  const options = args.find(
    (entry) => entry && typeof entry === "object" && !(entry instanceof URL),
  )
  const headers = (options && options.headers) || {}
  return `${(options && options.path) || ""} with the token ${JSON.stringify(
    headers["HireFire-Token"] || "",
  )}`
}

if (record) {
  let holder = net.Socket.prototype.connect.toolsNetGuard
  if (!holder) {
    holder = { current, request: null }
    const connect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function guardedConnect(...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0]
      const options = first && typeof first === "object" ? first : {}
      const host = options.host || options.hostname || "localhost"
      if (!options.path && !LOCAL.has(host)) {
        fs.appendFileSync(
          record,
          `${host}:${options.port}\t${holder.current()}\t${
            holder.request || "(no request in flight)"
          }\n`,
        )
        options.lookup = () => {}
      }
      return connect.apply(this, args)
    }
    net.Socket.prototype.connect.toolsNetGuard = holder
    for (const transport of [require("http"), require("https")]) {
      const request = transport.request
      transport.request = function guardedRequest(...args) {
        const previous = holder.request
        holder.request = describeRequest(args)
        try {
          return request.apply(this, args)
        } finally {
          holder.request = previous
        }
      }
    }
  }
  holder.current = current
}
