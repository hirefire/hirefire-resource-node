// A user-supplied logger may lack the method or throw inside it. Logging runs in
// the dispatch loop and its crash backstop, so it must never throw: skip a
// missing method, swallow a throwing one.
function safeLog(logger, level, message) {
  try {
    if (logger && typeof logger[level] === "function") {
      logger[level](message)
    }
  } catch {
    // a logger failure must not propagate to the caller
  }
}

module.exports = safeLog
