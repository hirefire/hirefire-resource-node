const https = require('https');
const { Mutex } = require('async-mutex');

/**
 * The Web class is responsible for collecting and dispatching web metrics to the HireFire server.
 * This class is designed to function efficiently in various web server architectures, including both
 * non-forked (single-process) and forked (multi-process) server models.
 *
 * In a forked environment, such as with worker threads in Node.js, each worker will have its own
 * Web instance. This separation ensures that metrics are collected and dispatched independently by
 * each process. For this reason, it's recommended to start the Web instances within some sort of
 * initialization for each worker. This ensures that each worker initializes its own web instance
 * and associated dispatcher.
 *
 * Web is also async-safe, meaning it works well in the async nature of Node.js's single-threaded
 * event loop model.
 */
class Web {
  /**
   * Constructs the Web metric dispatcher.
   */
  constructor() {
    this.buffer = {};
    this.mutex = new Mutex();
    this.running = false;
    this.DISPATCH_INTERVAL = 5; // in seconds
    this.DISPATCH_TIMEOUT = 5; // in seconds
    this.BUFFER_TTL = 60; // in seconds
    this.logger = console; // replace with your preferred logging library
  }

  get token() {
    return process.env.HIREFIRE_TOKEN;
  }

  /**
   * Starts the dispatcher to continuously dispatch web metrics to the HireFire server.
   * If the dispatcher is already running, this method will have no effect.
   */
  async start() {
    const release = await this.mutex.acquire();
    try {
      if (this.running) return;
      this.running = true;
      this.logger.info("[HireFire] Starting web metrics dispatcher.");
    } finally {
      release();
    }

    this.dispatcher = setInterval(() => this.dispatch(), this.DISPATCH_INTERVAL*1000);
  }

  /**
   * Stops the dispatcher, ensuring that no further metrics are dispatched to the HireFire server.
   * If the dispatcher is not running, this method will have no effect.
   */
  async stop() {
    const release = await this.mutex.acquire();
    try {
      if (!this.running) return;
      this.running = false;
      clearInterval(this.dispatcher);
      this.logger.info("[HireFire] Web metrics dispatcher stopped.");
      this.logger.log("[HireFire] Web metrics dispatcher stopped.");
    } finally {
      release();
    }
  }

  /**
   * Adds a value to the buffer with the current timestamp.
   * @param {number} value - The request queue time in milliseconds to be added to the buffer.
   */
  async addToBuffer(value) {
    const release = await this.mutex.acquire();
    try {
      const timestamp = Math.floor(Date.now() / 1000); // seconds since the Epoch
      this.buffer[timestamp] = this.buffer[timestamp] || [];
      this.buffer[timestamp].push(value);
    } finally {
      release();
    }
  }

  /**
   * Flushes the current buffer, returning its contents.
   * @return {object} The contents of the buffer.
   */
  async flush() {
    const release = await this.mutex.acquire();
    try {
      const currentBuffer = this.buffer;
      this.buffer = {};
      return currentBuffer;
    } finally {
      release();
    }
  }

  /**
   * Dispatches the buffer contents to the HireFire servers.
   * If the buffer is empty, no action is taken.
   */
  async dispatch() {
    let buffer;
    try {
      buffer = await this.flush();
      if (Object.keys(buffer).length === 0) return;
      await this.submitBuffer(buffer);
    } catch (error) {
      await this.repopulateBuffer(buffer);
      this.logger.warn(`[HireFire] Error while dispatching web metrics: ${error.message}`);
    }
  }

  /**
   * Repopulates the buffer with the contents from the failed dispatch attempt.
   * @param {object} buffer - The buffer to repopulate.
   */
  async repopulateBuffer(buffer) {
    const release = await this.mutex.acquire();
    try {
      const now = Math.floor(Date.now() / 1000);
      Object.entries(buffer).forEach(([timestamp, values]) => {
        if (parseInt(timestamp) >= now - this.BUFFER_TTL) {
          this.buffer[timestamp] = this.buffer[timestamp] || [];
          this.buffer[timestamp].push(...values);
        }
      });
    } finally {
      release();
    }
  }

  /**
   * Sends the buffer contents to the HireFire server.
   * @param {object} buffer - The buffer to be sent to the server.
   */
  async submitBuffer(buffer) {
    if (!this.token) {
      throw new Error("HIREFIRE_TOKEN environment variable is not set.");
    }

    const data = JSON.stringify(buffer);
    const options = {
      hostname: 'logdrain.hirefire.io',
      port: 443,
      path: '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'HireFire-Token': this.token,
        'Content-Length': data.length
      }
    };

    return new Promise((resolve, reject) => {
      const req = https.request(options, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else if (res.statusCode >= 500) {
          reject(new Error(`Server responded with ${res.statusCode} status.`));
        } else {
          reject(new Error(`Unexpected response code ${res.statusCode}.`));
        }
      });

      req.on('error', (e) => {
        if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') {
          reject(new Error("Request timed out."));
        } else {
          reject(new Error(`Network error occurred (${e.message}).`));
        }
      });

      req.on('timeout', () => {
        req.abort();
        reject(new Error("Request timed out."));
      });

      req.setTimeout(this.DISPATCH_TIMEOUT*1000);
      req.write(data);
      req.end();
    });
  }
}

module.exports = { Web };
