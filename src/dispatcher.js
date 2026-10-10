const Session = require("./dispatcher/session")
const safeLog = require("./log")

class Dispatcher {
  static JOIN_TIMEOUT = 5

  constructor(configuration) {
    this._configuration = configuration
    this._session = null
    this._stopping = false
  }

  start() {
    if (this._stopping || this._session) return false

    this._session = new Session(this._configuration).start()
    this._log("info", "Starting dispatcher.")
    return true
  }

  async stop({ flush = true } = {}) {
    const session = this._session
    if (this._stopping || !session) return false

    this._stopping = true
    this._session = null
    try {
      session.halt()
      const joined = await session.join(Dispatcher.JOIN_TIMEOUT)
      if (!flush) {
        this._configuration.buffer.discard()
      } else if (!joined) {
        this._log(
          "warn",
          "The dispatch loop did not stop within " +
            `${Dispatcher.JOIN_TIMEOUT} seconds. The final flush is skipped.`,
        )
      } else if (session.failing) {
        this._log(
          "warn",
          "The last dispatch failed. The final flush is skipped.",
        )
      } else {
        await session.flush()
      }

      if (joined) await session.close()
      else session.abandon()

      this._log("info", "Dispatcher stopped.")
      return true
    } finally {
      this._stopping = false
    }
  }

  running() {
    return this._session !== null
  }

  _log(level, message) {
    safeLog(this._configuration.logger, level, `[HireFire] ${message}`)
  }
}

module.exports = Dispatcher
