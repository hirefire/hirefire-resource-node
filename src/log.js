function formatError(error) {
  const text =
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return text.replace(/(:\/\/)([^/@\s]+)@/g, "$1***@")
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
