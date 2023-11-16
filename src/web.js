const https = require('https')
const { Mutex } = require('async-mutex')

/**
 * The Web class is responsible for collecting and dispatching web metrics to HireFire's servers.
 * It functions efficiently in various web server architectures, including both non-forked and
 * forked server models.
 *
 * @property {number} DISPATCH_INTERVAL - The interval between dispatch attempts in seconds.
 * @property {number} DISPATCH_TIMEOUT - The timeout for HTTP requests in seconds.
 * @property {number} BUFFER_TTL - Buffer's Time-To-Live in seconds. Metrics older than this value will be discarded.
 * @property {Object} buffer - Private. Buffer storing request queue time metrics, keyed by timestamp.
 * @property {Mutex} mutex - Mutex for ensuring thread safety across asynchronous operations.
 * @property {boolean} running - Indicates whether the dispatcher is currently running.
 * @property {Console} logger - Logger for logging messages and errors. Defaults to console.
 */
class Web {
  static DISPATCH_INTERVAL = 5
  static DISPATCH_TIMEOUT = 5
  static BUFFER_TTL = 60

  constructor () {
    /** @private */
    this.buffer = {}

    this.mutex = new Mutex()
    this.running = false
    this.logger = console
  }

  /**
   * Starts the dispatcher to continuously dispatch web metrics to HireFire's servers. If the
   * dispatcher is already running, this method will have no effect.
   * @async
   * @example
   * const web = new Web();
   * await web.start();
   */
  async start () {
    const release = await this.mutex.acquire()

    try {
      if (this.running) return
      this.running = true
      this.logger.info('[HireFire] Starting web metrics dispatcher.')
    } finally {
      release()
    }

    this.dispatcher = setInterval(
      () => this.dispatch(),
      Web.DISPATCH_INTERVAL * 1000
    )
  }

  /**
   * Stops the dispatcher, ensuring that no further metrics are dispatched to HireFire's servers.
   * If the dispatcher is not running, this method will have no effect.
   *
   * The buffer will be cleared after stopping the dispatcher.
   *
   * @async
   * @example
   * const web = new Web();
   * await web.start();
   * // ... some time later ...
   * await web.stop();
   */
  async stop () {
    const release = await this.mutex.acquire()

    try {
      if (!this.running) return
      this.running = false
      clearInterval(this.dispatcher)
      this.logger.info('[HireFire] Web metrics dispatcher stopped.')
    } finally {
      release()
    }

    await this.flush()
  }

  /**
   * Adds a value to the buffer with the current timestamp.
   * @async
   * @param {number} value - The request queue time in milliseconds to be added to the buffer.
   */
  async addToBuffer (value) {
    const release = await this.mutex.acquire()

    try {
      const timestamp = Math.floor(Date.now() / 1000)
      this.buffer[timestamp] = this.buffer[timestamp] || []
      this.buffer[timestamp].push(value)
    } finally {
      release()
    }
  }

  /**
   * Flushes the current buffer, returning its contents. After calling this method, the internal
   * buffer will be reset to an empty state, ensuring that the same data isn't dispatched more than
   * once.
   * @async
   * @return {object} The contents of the buffer before it was cleared.
   */
  async flush () {
    const release = await this.mutex.acquire()

    try {
      const currentBuffer = this.buffer
      this.buffer = {}
      return currentBuffer
    } finally {
      release()
    }
  }

  /**
   * Dispatches the buffer contents to HireFire's servers. If the buffer is empty, no action is
   * taken.
   * @async
   */
  async dispatch () {
    let buffer

    try {
      buffer = await this.flush()
      if (Object.keys(buffer).length === 0) return
      await this.submitBuffer(buffer)
    } catch (error) {
      await this.repopulateBuffer(buffer)
      this.logger.warn(
        `[HireFire] Error while dispatching web metrics: ${error.message}`
      )
    }
  }

  /**
   * Repopulates the buffer with the contents from a failed dispatch attempt. Filters out any
   * entries older than the `BUFFER_TTL` value to ensure only recent data is preserved.
   * @async
   * @param {object} buffer - The buffer to repopulate.
   */
  async repopulateBuffer (buffer) {
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

  /**
   * Sends the buffer contents to HireFire's servers using a POST request. This method ensures that
   * the contents of the buffer are transmitted securely using HTTPS. It handles HTTP success and
   * server error responses, raising corresponding exceptions for error statuses.
   * @async
   * @param {object} buffer - The buffer to be sent to the server.
   * @throws {Error} Throws an error if there's a network-related issue.
   * @return {Promise<void>}
   */
  async submitBuffer (buffer) {
    const data = JSON.stringify(buffer)
    const options = {
      hostname: 'logdrain.hirefire.io',
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'HireFire-Token': process.env.HIREFIRE_TOKEN,
        'Content-Length': data.length
      }
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

      req.on('error', (e) => {
        if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') {
          reject(new Error('Request timed out.'))
        } else {
          reject(new Error(`Network error occurred (${e.message}).`))
        }
      })

      req.on('timeout', () => {
        req.abort()
        reject(new Error('Request timed out.'))
      })

      req.setTimeout(Web.DISPATCH_TIMEOUT * 1000)
      req.write(data)
      req.end()
    })
  }
}

module.exports = { Web }
