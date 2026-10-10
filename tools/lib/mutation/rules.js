"use strict"

const { rule } = require("./verdicts")

const SESSION = "src/dispatcher/session.js"
const LEASE = "src/lease.js"
const PG_BOSS = "src/macro/pg_boss.js"

rule(
  {
    mutator: "statement",
    original: /^this\._\w+ = (null|false)$/,
    replacement: ";",
  },
  "equivalent",
  "a field that is never set reads as null or false in every check of its class",
)
rule(
  {
    file: LEASE,
    mutator: "statement",
    original: /^this\._(expiresAt|nextSampleAt) = performance\.now\(\)$/,
    on: /^ {4}this\._(expiresAt|nextSampleAt) = performance\.now\(\)$/,
  },
  "equivalent",
  "a lease without a time for its first request asks at once, and its first grant sets the time of the first sample",
)
rule(
  {
    mutator: "string",
    replacement: '""',
    on: /^\s+"[a-z]+(_[a-z]+)+",$/,
    files:
      /^src\/(sampler|lease|middleware|configuration|dispatcher\/session)\.js$/,
  },
  "equivalent",
  "the kind of a once-only line only keeps its keys apart from those of another kind, and an empty kind still differs from every other",
)
rule(
  { file: SESSION, mutator: "number", original: "5", replacement: "6" },
  "equivalent",
  "five doublings of the lowest dispatch frequency already pass the limit of 30 seconds, so a sixth changes no interval",
)
rule(
  {
    file: SESSION,
    mutator: "condition",
    original: "this._lease.granted()",
    replacement: "true",
  },
  "equivalent",
  "a sample loop that starts without the lease ends before its first round, because the loop checks the lease itself",
)
rule(
  {
    file: SESSION,
    mutator: "statement",
    original: "this._sleepers.delete(sleeper)",
  },
  "accepted",
  "a sleeper that stays in the set costs memory and changes no result, which only the soak run can see",
)
rule(
  {
    files: /^src\/macro\/bull(mq)?\.js$/,
    mutator: "string",
    original: '"-inf"',
  },
  "equivalent",
  "Redis reads an empty minimum as zero, and no score of the delayed set is below zero",
)
rule(
  { file: PG_BOSS, on: /connectionIdSeq/ },
  "equivalent",
  "the number only has to differ from one borrowed connection to the next",
)
rule(
  { file: PG_BOSS, mutator: "string", on: /opts\.database \|\| ""/ },
  "equivalent",
  "the text stands in for a missing database name in a cache key, and every text does that",
)
rule(
  {
    file: "src/dispatcher/payload.js",
    mutator: "number",
    on: /EMPTY_BUCKET = /,
    original: "0",
    replacement: "1",
  },
  "equivalent",
  "a bucket without a request is sent as an empty leaf, whatever its sum",
)
rule(
  {
    file: "src/middleware.js",
    mutator: "number",
    original: "1e17",
    replacement: "100000000000000000",
  },
  "equivalent",
  "both texts are the same number",
)
rule(
  {
    file: "src/buffer.js",
    mutator: "boundary",
    on: /count > MetricsBuffer\.SAMPLE_COUNT_LIMIT/,
  },
  "equivalent",
  "a bucket of exactly the limit keeps its mean and its count when it is clamped to the limit",
)
rule(
  {
    file: "src/source/cpu/usage.js",
    mutator: "number",
    original: "1",
    replacement: "2",
    on: /\.slice\(close \+ 1\)/,
  },
  "equivalent",
  "the character after the closing parenthesis of a stat line is a space, which the trim removes",
)
