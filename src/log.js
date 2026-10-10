function formatError(error) {
  try {
    const text =
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    return text.replace(/(:\/\/)[^\s]*@/g, "$1***@")
  } catch {
    return `an error that cannot be shown (${typeof error})`
  }
}

function verbose() {
  const value = String(process.env.HIREFIRE_VERBOSE ?? "").toLowerCase()
  return value !== "" && !["0", "false", "no"].includes(value)
}

function safeLog(logger, level, message) {
  try {
    if (logger && typeof logger[level] === "function") {
      logger[level](message)
    }
  } catch {}
}

module.exports = safeLog
module.exports.formatError = formatError
module.exports.verbose = verbose
