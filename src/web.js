const https = require("https")
const { Mutex } = require("async-mutex")
const pkg = require("../package.json")

class Web {
  static DISPATCH_INTERVAL = 5
  static DISPATCH_TIMEOUT = 5
  static BUFFER_TTL = 60

  constructor() {
    this.buffer = {}
    this.mutex = new Mutex()
    this.running = false
    this.configuration = null
  }

  async startDispatcher() {
    const release = await this.mutex.acquire()

    try {
      if (this.running) return
      this.running = true
    } finally {
      release()
    }

    this.logger.info("[HireFire] Starting web metrics dispatcher.")

    this.dispatcher = setInterval(
      this.dispatchBuffer.bind(this),
      Web.DISPATCH_INTERVAL * 1000,
    )
  }

  async stopDispatcher() {
    const release = await this.mutex.acquire()

    try {
      if (!this.running) return
      this.running = false
      clearInterval(this.dispatcher)
    } finally {
      release()
    }

    await this.flushBuffer()

    this.logger.info("[HireFire] Web metrics dispatcher stopped.")
  }

  async addToBuffer(value) {
    const release = await this.mutex.acquire()

    try {
      const timestamp = Math.floor(Date.now() / 1000)
      this.buffer[timestamp] = this.buffer[timestamp] || []
      this.buffer[timestamp].push(value)
    } finally {
      release()
    }
  }

  async flushBuffer() {
    const release = await this.mutex.acquire()

    try {
      const currentBuffer = this.buffer
      this.buffer = {}
      return currentBuffer
    } finally {
      release()
    }
  }

  async dispatchBuffer() {
    let buffer

    try {
      buffer = await this.flushBuffer()
      if (Object.keys(buffer).length === 0) return
      await this.submitBuffer(buffer)
    } catch (error) {
      await this.repopulateBuffer(buffer)
      this.logger.error(
        `[HireFire] Error while dispatching web metrics: ${error.message}`,
      )
    }
  }

  async repopulateBuffer(buffer) {
    const release = await this.mutex.acquire()

    try {
      const now = Math.floor(Date.now() / 1000)
      Object.entries(buffer).forEach(([timestamp, values]) => {
        if (parseInt(timestamp) >= now - Web.BUFFER_TTL) {
          this.buffer[timestamp] = this.buffer[timestamp] || []
          this.buffer[timestamp].push(...values)
        }
      })
    } finally {
      release()
    }
  }

  async submitBuffer(buffer) {
    const data = JSON.stringify(buffer)
    const options = {
      hostname: "logdrain.hirefire.io",
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "HireFire-Token": process.env.HIREFIRE_TOKEN,
        "HireFire-Resource": `Node-${pkg.version}`,
        "Content-Length": data.length,
      },
    }

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve()
        } else if (res.statusCode >= 500) {
          reject(new Error(`Server responded with ${res.statusCode} status.`))
        } else {
          reject(new Error(`Unexpected response code ${res.statusCode}.`))
        }
      })

      req.on("error", (e) => {
        if (e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT") {
          reject(new Error("Request timed out."))
        } else {
          reject(new Error(`Network error occurred (${e.message}).`))
        }
      })

      req.on("timeout", () => {
        req.abort()
        reject(new Error("Request timed out."))
      })

      req.setTimeout(Web.DISPATCH_TIMEOUT * 1000)
      req.write(data)
      req.end()
    })
  }

  get logger() {
    if (this.configuration) {
      return this.configuration.logger
    } else {
      return console
    }
  }
}

module.exports = Web
