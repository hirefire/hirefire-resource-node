"use strict"

const { rule } = require("./verdicts")

const DISPATCHER = "src/dispatcher.js"
const UNREF = /\.unref/

rule(
  { mutator: "condition", original: UNREF, replacement: "true" },
  "equivalent",
  "a timer of every supported Node has unref, so the check is always true",
)
rule(
  { file: "src/source/cpu/usage.js", lines: [152], replacement: "true" },
  "equivalent",
  "os.availableParallelism exists on every supported Node",
)
rule(
  { original: UNREF },
  "finding",
  "N:mut-lifecycle: no test checks that a timer of the library is unref'd",
)
rule(
  { file: "src/source/cpu/usage.js", from: 152, to: 158 },
  "finding",
  "N:below-floor: the fallback for a Node without os.availableParallelism cannot run",
)
rule(
  { file: DISPATCHER, from: 526, to: 540 },
  "finding",
  "N:dead-code: the second loop checks of _dispatch cannot be reached without an await",
)
rule(
  { file: DISPATCHER, from: 705, to: 713 },
  "finding",
  "N:dead-code: _mergeMetrics never meets an existing bucket",
)
rule(
  { file: DISPATCHER, from: 682, to: 692 },
  "finding",
  "N:dead-code: the doubled liveness condition and the branch behind it",
)
rule(
  { file: "src/sample.js", from: 5, to: 7 },
  "finding",
  "N:dead-code: coerceSample runs on a value that is already a number",
)
rule(
  { file: "src/plan.js", from: 140, to: 157 },
  "finding",
  "N:dead-code: reinitMacrosAfterFork has no caller",
)
rule(
  { file: "src/plan.js", lines: [295, 299, 307] },
  "finding",
  "N:dead-code: the return values of sampleJobStrategy are not read",
)
rule(
  { file: "src/plan.js", from: 166, to: 214 },
  "finding",
  "N:plan-twice: these checks of Plan.execute repeat what the dispatcher checked",
)
rule(
  { files: /^src\/macro\/(bull|bullmq)\.js$/, from: 27, to: 29 },
  "finding",
  "N:dead-code: reinitAfterFork has no caller",
)
rule(
  { file: "src/plan/hooks.js", from: 2, to: 24 },
  "finding",
  "N:dead-code: hook defaults that every macro replaces or that do nothing",
)
rule(
  { file: "src/configuration.js", lines: [166] },
  "finding",
  "N:dead-code: _register has one source kind",
)
rule(
  { file: "src/buffer.js", lines: [38, 39] },
  "finding",
  "N:dead-code: discardInherited is flush without a return value",
)
rule({ unrun: true }, "finding", "N:unrun-lines: the line runs in no cell")
rule(
  { mutator: "string", original: /\[HireFire\]|\s\S+\s|^`/ },
  "finding",
  "N:mut-logs: the text of a log line or an error message is not asserted",
)
rule(
  { mutator: ["string", "statement"], original: /Error"|this\.name = / },
  "finding",
  "N:mut-logs: the name of an error class is not asserted",
)
rule(
  { file: DISPATCHER, from: 413, to: 478 },
  "finding",
  "N:mut-logs: a once-only warning can repeat or vanish without a failing test",
)
rule(
  { file: "src/configuration.js", from: 182, to: 241 },
  "finding",
  "N:mut-logs: a once-only warning can repeat or vanish without a failing test",
)
rule(
  { file: "src/probe.js", from: 55, to: 72 },
  "finding",
  "N:mut-logs: the verbose lines of a sample round are not asserted",
)
rule(
  { mutator: "number" },
  "finding",
  "N:mut-limits: a limit or default can change by one without a failing test",
)
rule(
  { mutator: "boundary" },
  "finding",
  "N:mut-limits: no test sits on the boundary of this comparison",
)
rule(
  { file: DISPATCHER, from: 46, to: 272 },
  "finding",
  "N:mut-lifecycle: a state change of start, stop, or a loop is not pinned",
)
rule(
  { file: DISPATCHER, from: 485, to: 771 },
  "finding",
  "N:mut-dispatch: a rule of the dispatch or of the payload is not pinned",
)
rule(
  { file: "src/lease.js" },
  "finding",
  "N:mut-lease: a rule of the lease is not pinned",
)
rule(
  { files: /^src\/macro\// },
  "finding",
  "N:mut-adapters: a branch of a macro is not pinned",
)
rule(
  {},
  "finding",
  "N:mut-guards: a guard or fallback that no test contradicts",
)
