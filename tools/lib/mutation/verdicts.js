"use strict"

const RULES = []

function rule(match, verdict, reason) {
  RULES.push({ match, verdict, reason })
}

function verdictFor(mutant) {
  for (const entry of RULES) {
    const match = entry.match
    if (match.file && match.file !== mutant.file) continue
    if (match.lines && !match.lines.includes(mutant.line)) continue
    if (match.from && (mutant.line < match.from || mutant.line > match.to)) {
      continue
    }
    if (match.mutator && ![].concat(match.mutator).includes(mutant.mutator)) {
      continue
    }
    if (match.original && !match.original.test(mutant.original)) continue
    return { verdict: entry.verdict, reason: entry.reason }
  }
  return null
}

module.exports = { rule, verdictFor, RULES }
