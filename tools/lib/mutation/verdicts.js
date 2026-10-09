"use strict"

const RULES = []

function rule(match, verdict, reason) {
  RULES.push({ match, verdict, reason })
}

function matches(match, mutant) {
  if (match.file && match.file !== mutant.file) return false
  if (match.files && !match.files.test(mutant.file)) return false
  if (match.lines && !match.lines.includes(mutant.line)) return false
  if (match.from && (mutant.line < match.from || mutant.line > match.to)) {
    return false
  }
  if (match.mutator && ![].concat(match.mutator).includes(mutant.mutator)) {
    return false
  }
  if (match.original && !match.original.test(mutant.original)) return false
  if (match.replacement && match.replacement !== mutant.replacement)
    return false
  if (match.unrun && !mutant.unrun) return false
  return true
}

function verdictFor(mutant) {
  for (const entry of RULES) {
    if (matches(entry.match, mutant)) {
      return { verdict: entry.verdict, reason: entry.reason }
    }
  }
  return null
}

module.exports = { rule, verdictFor, RULES }
