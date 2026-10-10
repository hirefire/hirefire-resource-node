function formatError(error) {
  try {
    return String(error).replace(/(:\/\/)[^\s]*@/g, "$1***@")
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
    logger?.[level]?.(message)
  } catch {}
}

module.exports = safeLog
module.exports.formatError = formatError
module.exports.verbose = verbose
