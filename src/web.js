const https = require('https')
const { Mutex } = require('async-mutex')
const pkg = require('../package.json')

/**
 * Manages the collection and dispatching of web metrics to HireFire's servers.
 * Suitable for use in different web server architectures, including non-forked and forked models.
 * This class handles the periodic dispatch of metrics, ensuring they are securely transmitted
 * and relevant based on a defined TTL (Time-To-Live).
 *
 * @property {number} DISPATCH_INTERVAL - Interval between dispatch attempts in seconds.
 * @property {number} DISPATCH_TIMEOUT - Timeout for HTTP requests in seconds.
 * @property {number} BUFFER_TTL - Buffer's Time-To-Live in seconds. Metrics older than this are discarded.
 * @property {Object} buffer - (Private) Stores request queue time metrics, keyed by timestamp.
 * @property {Mutex} mutex - Ensures thread safety across asynchronous operations.
 * @property {boolean} running - Indicates if the dispatcher is actively running.
 * @property {Console} logger - Logger for messages and errors, defaults to console.
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
   * Starts the dispatcher to periodically dispatch web metrics. No effect if already running.
   * Uses a setInterval to regularly call the dispatch method based on DISPATCH_INTERVAL.
   * @async
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
   * Stops the dispatcher, preventing further metric dispatches. Clears the buffer.
   * No effect if the dispatcher is not running.
   * @async
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
   * Adds a metric value to the buffer. Metrics are keyed by current timestamp.
   * @async
   * @param {number} value - The request queue time in milliseconds.
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
   * Flushes the buffer, returning its contents and resetting to an empty state.
   * Ensures no duplicate dispatch of the same data.
   * @async
   * @return {object} Contents of the buffer before clearing.
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
   * Dispatches buffered metrics. Skips if buffer is empty. Handles errors and repopulates buffer on failure.
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
   * Repopulates buffer with failed dispatch data. Filters out entries older than BUFFER_TTL.
   * @async
   * @param {object} buffer - Buffer content from a failed dispatch.
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
   * Sends buffer data to HireFire's servers securely via HTTPS POST request.
   * Handles HTTP responses and raises errors for network issues.
   * @async
   * @param {object} buffer - Buffer data to send.
   * @throws {Error} - In case of network-related issues or server errors.
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
        'HireFire-Resource': `Node-${pkg.version}`,
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
