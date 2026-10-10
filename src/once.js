const safeLog = require("./log")

class Once {
  static LIMIT = 256

  constructor(configuration) {
    this._configuration = configuration
    this._seen = new Map()
  }

  log(level, kind, key, message) {
    if (!this._seen.has(kind)) this._seen.set(kind, new Set())
    const seen = this._seen.get(kind)
    if (seen.has(key)) return

    if (seen.size >= Once.LIMIT) seen.delete(seen.values().next().value)
    seen.add(key)
    safeLog(this._configuration.logger, level, message)
  }
}

module.exports = Once
