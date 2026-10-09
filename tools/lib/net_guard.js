"use strict"

const fs = require("fs")
const net = require("net")
const path = require("path")

const record = process.env.TOOLS_NET_GUARD
const LOCAL = new Set(["127.0.0.1", "::1", "localhost"])
const source = path.resolve(__dirname, "..", "..", "src")
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

if (record) {
  if (!process.toolsNetGuard) {
    const holder = { current, origin: null }
    process.toolsNetGuard = holder
    const connect = net.Socket.prototype.connect
    net.Socket.prototype.connect = function guardedConnect(...args) {
      const first = Array.isArray(args[0]) ? args[0][0] : args[0]
      const options = first && typeof first === "object" ? first : {}
      const host = options.host || options.hostname || "localhost"
      if (!options.path && !LOCAL.has(host)) {
        fs.appendFileSync(
          record,
          `${host}:${options.port}\t${holder.current()}\t${
            holder.origin ||
            (options.agent && options.agent.toolsOrigin
              ? `later socket of ${options.agent.toolsOrigin}`
              : `(not a client request) ${new Error().stack
                  .split("\n")
                  .slice(2, 14)
                  .map((line) => line.trim().replace(root, ""))
                  .join(" <- ")}`)
          }\n`,
        )
        options.lookup = () => {}
      }
      return connect.apply(this, args)
    }
  }
  const holder = process.toolsNetGuard
  holder.current = current
  try {
    const Dispatcher = require(path.join(source, "dispatcher"))
    const { Client } = require(path.join(source, "client"))
    const start = Dispatcher.prototype.start
    Dispatcher.prototype.start = function guardedStart(...args) {
      if (!this.startedBy) this.startedBy = current()
      return start.apply(this, args)
    }
    const execute = Client.prototype._executeUntracked
    Client.prototype._executeUntracked = function guardedExecute(...args) {
      const configuration = this._configuration
      const dispatcher = configuration && configuration._dispatcher
      holder.origin =
        (dispatcher && dispatcher.startedBy) ||
        `a client without a started dispatcher, created in ${current()}`
      try {
        return execute.apply(this, args)
      } finally {
        if (this._agent) this._agent.toolsOrigin = holder.origin
        holder.origin = null
      }
    }
  } catch {}
}
