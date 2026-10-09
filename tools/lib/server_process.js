"use strict"

const { fork } = require("child_process")
const path = require("path")

class ServerProcess {
  static async start({ record = true } = {}) {
    const child = fork(path.join(__dirname, "fake_server.js"), [], {
      env: { ...process.env, TOOLS_RECORD: record ? "1" : "0" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    const server = new ServerProcess(child)
    await new Promise((resolve) => {
      child.once("message", (message) => {
        server.port = message.port
        server.url = `http://127.0.0.1:${message.port}`
        resolve()
      })
    })
    child.on("message", (message) => {
      const waiting = server.waiting.get(message.id)
      if (!waiting) return
      server.waiting.delete(message.id)
      waiting(message)
    })
    return server
  }

  constructor(child) {
    this.child = child
    this.waiting = new Map()
    this.next = 0
  }

  call(cmd, args = {}) {
    return new Promise((resolve) => {
      this.next += 1
      this.waiting.set(this.next, resolve)
      this.child.send({ id: this.next, cmd, ...args })
    })
  }

  mode(name) {
    return this.call("mode", { name })
  }

  plan(plan, frequency, hugeAdapter) {
    return this.call("plan", {
      plan: JSON.stringify(plan),
      frequency,
      hugeAdapter,
    })
  }

  snapshot() {
    return this.call("snapshot")
  }

  async requests(since, full = false) {
    return (await this.call("requests", { since, full })).requests
  }

  async stop() {
    await this.call("stop")
  }
}

module.exports = ServerProcess
