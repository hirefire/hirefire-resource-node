const safeLog = require("../log")
const { formatError } = safeLog

class FailureLog {
  static INTERVAL = 60

  constructor(label, configuration) {
    this._label = label
    this._configuration = configuration
    this._loggedAt = null
    this.count = 0
  }

  failed(error) {
    this.record(`${this._label} error: ${formatError(error)}`)
  }

  record(message) {
    this.count += 1
    const now = performance.now()
    if (
      this._loggedAt !== null &&
      now - this._loggedAt < FailureLog.INTERVAL * 1000
    ) {
      return
    }

    this._loggedAt = now
    const attempts =
      this.count > 1 ? ` (${this.count} failed attempts in a row)` : ""
    this._log("error", `${message}${attempts}`)
  }

  recovered() {
    if (this.count > 1) {
      this._log(
        "info",
        `${this._label} recovered after ${this.count} failed attempts.`,
      )
    }
    this.count = 0
    this._loggedAt = null
  }

  _log(level, message) {
    safeLog(this._configuration.logger, level, `[HireFire] ${message}`)
  }
}

module.exports = FailureLog
