const BLOCKED_ABSENT_TTL_MS = 60_000
const present = new Set()
const absentUntil = new Map()

function reset() {
  present.clear()
  absentUntil.clear()
}

module.exports = {
  BLOCKED_ABSENT_TTL_MS,
  present,
  absentUntil,
  reset,
}
