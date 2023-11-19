const https = require("https")
const { Mutex } = require("async-mutex")
const VERSION = require("../src/version")

class Web {
  static DISPATCH_INTERVAL = 5
  static DISPATCH_TIMEOUT = 5
  static BUFFER_TTL = 60

  constructor(configuration) {
    this._buffer = {}
    this._mutex = new Mutex()
    this._dispatcherRunning = false
    this._configuration = configuration
  }

  async startDispatcher() {
    const release = await this._mutex.acquire()

    try {
      if (this._dispatcherRunning) return false
      this._dispatcherRunning = true
    } finally {
      release()
    }

    this._logger.info("[HireFire] Starting web metrics dispatcher.")

    this.dispatcher = setInterval(
      this._dispatchBuffer.bind(this),
      Web.DISPATCH_INTERVAL * 1000,
    )

    return true
  }

  async stopDispatcher() {
    const release = await this._mutex.acquire()

    try {
      if (!this._dispatcherRunning) return false
      this._dispatcherRunning = false
      clearInterval(this.dispatcher)
    } finally {
      release()
    }

    await this._flushBuffer()

    this._logger.info("[HireFire] Web metrics dispatcher stopped.")

    return true
  }

  dispatcherRunning() {
    return this._dispatcherRunning
  }

  async addToBuffer(requestQueueTime) {
    const release = await this._mutex.acquire()

    try {
      const timestamp = Math.floor(Date.now() / 1000)
      this._buffer[timestamp] = this._buffer[timestamp] || []
      this._buffer[timestamp].push(requestQueueTime)
    } finally {
      release()
    }
  }

  async _flushBuffer() {
    const release = await this._mutex.acquire()

    try {
      const currentBuffer = this._buffer
      this._buffer = {}
      return currentBuffer
    } finally {
      release()
    }
  }

  async _dispatchBuffer() {
    let buffer

    try {
      buffer = await this._flushBuffer()
      if (Object.keys(buffer).length === 0) return
      await this._submitBuffer(buffer)
    } catch (error) {
      await this._repopulateBuffer(buffer)
      this._logger.error(
        `[HireFire] Error while dispatching web metrics: ${error.message}`,
      )
    }
  }

  async _repopulateBuffer(buffer) {
    const release = await this._mutex.acquire()

    try {
      const now = Math.floor(Date.now() / 1000)
      Object.entries(buffer).forEach(([timestamp, requestQueueTimes]) => {
        if (parseInt(timestamp) >= now - Web.BUFFER_TTL) {
          this._buffer[timestamp] = this._buffer[timestamp] || []
          this._buffer[timestamp].push(...requestQueueTimes)
        }
      })
    } finally {
      release()
    }
  }

  async _submitBuffer(buffer) {
    const data = JSON.stringify(buffer)
    const options = {
      hostname: "logdrain.hirefire.io",
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "HireFire-Token": process.env.HIREFIRE_TOKEN,
        "HireFire-Resource": `Node-${VERSION}`,
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

  get _logger() {
    return this._configuration.logger
  }
}

module.exports = Web
