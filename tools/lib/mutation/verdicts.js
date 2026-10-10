"use strict"

const fs = require("fs")
const path = require("path")
const { root } = require("../paths")

const RULES = []
const sources = new Map()

function rule(match, verdict, reason) {
  RULES.push({ match, verdict, reason })
}

function lineOf(mutant) {
  if (!sources.has(mutant.file)) {
    sources.set(
      mutant.file,
      fs.readFileSync(path.join(root, mutant.file), "utf8").split("\n"),
    )
  }
  return sources.get(mutant.file)[mutant.line - 1] || ""
}

function fits(expected, text) {
  return typeof expected === "string" ? expected === text : expected.test(text)
}

function matches(match, mutant) {
  if (match.file && match.file !== mutant.file) return false
  if (match.files && !match.files.test(mutant.file)) return false
  if (match.mutator && ![].concat(match.mutator).includes(mutant.mutator)) {
    return false
  }
  if (match.original != null && !fits(match.original, mutant.original)) {
    return false
  }
  if (
    match.replacement != null &&
    !fits(match.replacement, mutant.replacement)
  ) {
    return false
  }
  if (match.on && !match.on.test(lineOf(mutant))) return false
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
