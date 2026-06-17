function safeLog(logger, level, message) {
  try {
    if (logger && typeof logger[level] === "function") {
      logger[level](message)
    }
  } catch {}
}

module.exports = safeLog
