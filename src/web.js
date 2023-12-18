const https = require("https")
const { Mutex } = require("async-mutex")
const VERSION = require("../src/version")

class DispatchError extends Error {
  constructor(message) {
    super(message)
    this.name = "DispatchError"
  }
}

class Web {
  constructor(configuration) {
    this._buffer = {}
    this._mutex = new Mutex()
    this._dispatcherRunning = false
    this._configuration = configuration
    this._dispatchInterval = 1
    this._dispatchTimeout = 5
    this._bufferTTL = 60
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
      this._dispatchInterval * 1000,
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

      if (Object.keys(buffer).length === 0) {
        return
      }

      if (process.env.HIREFIRE_VERBOSE) {
        this._logger.info(
          `[HireFire] Dispatching web metrics: ${JSON.stringify(buffer)}`,
        )
      }

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
        if (parseInt(timestamp) >= now - this._bufferTTL) {
          this._buffer[timestamp] = this._buffer[timestamp] || []
          this._buffer[timestamp].push(...requestQueueTimes)
        }
      })
    } finally {
      release()
    }
  }

  async _submitBuffer(buffer) {
    const hirefireToken = process.env.HIREFIRE_TOKEN

    if (!hirefireToken) {
      throw new DispatchError(
        "The HIREFIRE_TOKEN environment variable is not set. Unable to submit " +
          "Request Queue Time metric data. The HIREFIRE_TOKEN can be found in " +
          "the HireFire Web UI in the web dyno manager settings.",
      )
    }

    const data = JSON.stringify(buffer)
    const dispatchUrl = (
      process.env.HIREFIRE_DISPATCH_URL || "logdrain.hirefire.io"
    ).replace(/^(https?:\/\/)/, "")
    const options = {
      hostname: dispatchUrl,
      port: 443,
      path: "/",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "HireFire-Token": hirefireToken,
        "HireFire-Resource": `Node-${VERSION}`,
        "Content-Length": data.length,
      },
    }

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          this._adjustParameters(res)
          resolve()
        } else if (res.statusCode >= 500) {
          reject(
            new DispatchError(
              `Server responded with ${res.statusCode} status.`,
            ),
          )
        } else {
          reject(
            new DispatchError(`Unexpected response code ${res.statusCode}.`),
          )
        }
      })

      req.on("error", (e) => {
        if (e.code === "ETIMEDOUT" || e.code === "ESOCKETTIMEDOUT") {
          reject(new DispatchError("Request timed out."))
        } else {
          reject(new DispatchError(`Network error occurred (${e.message}).`))
        }
      })

      req.on("timeout", () => {
        req.destroy()
        reject(new DispatchError("Request timed out."))
      })

      req.setTimeout(this._dispatchTimeout * 1000)
      req.write(data)
      req.end()
    })
  }

  _adjustParameters(res) {
    if (res.headers["hirefire-resource-dispatcher-interval"]) {
      this._dispatchInterval = parseInt(
        res.headers["hirefire-resource-dispatcher-interval"],
      )
    }
    if (res.headers["hirefire-resource-dispatcher-timeout"]) {
      this._dispatchTimeout = parseInt(
        res.headers["hirefire-resource-dispatcher-timeout"],
      )
    }
    if (res.headers["hirefire-resource-buffer-ttl"]) {
      this._bufferTTL = parseInt(res.headers["hirefire-resource-buffer-ttl"])
    }
  }

  get _logger() {
    return this._configuration.logger
  }
}

module.exports = { Web, DispatchError }
