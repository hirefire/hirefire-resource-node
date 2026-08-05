const safeLog = require("./log")

const STRATEGIES = {
  jql: "jobQueueLatency",
  jqs: "jobQueueSize",
}

const MAX_QUEUES = 64
const MAX_QUEUE_NAME_BYTES = 128

/**
 * Lease collection plans: resolve adapters, strategies, and execute plan entries.
 */
const Plan = {
  ADAPTERS: {
    get bull() {
      return require("./macro/bull")
    },
    get bullmq() {
      return require("./macro/bullmq")
    },
    get pg_boss() {
      return require("./macro/pg_boss")
    },
  },

  STRATEGIES,

  MAX_QUEUES,
  MAX_QUEUE_NAME_BYTES,

  anyAllowlistedJobQueueLibraryLoaded() {
    return (
      libraryLoaded("bullmq") ||
      libraryLoaded("bull") ||
      libraryLoaded("pg_boss")
    )
  },

  knownAdapter(adapter) {
    return String(adapter) in this.ADAPTERS
  },

  libraryLoaded(adapter) {
    return libraryLoaded(adapter)
  },

  executable(adapter) {
    return this.knownAdapter(adapter) && this.libraryLoaded(adapter)
  },

  knownStrategy(strategy) {
    return Object.prototype.hasOwnProperty.call(STRATEGIES, String(strategy))
  },

  /**
   * @param {string|symbol} adapter
   * @param {string|symbol} strategy
   * @returns {boolean}
   */
  supportsStrategy(adapter, strategy) {
    if (!this.knownAdapter(adapter)) return false
    if (!this.knownStrategy(strategy)) return false
    const macro = this.ADAPTERS[String(adapter)]
    if (!macro || typeof macro.supportsPlanStrategy !== "function") return false
    return macro.supportsPlanStrategy(strategy)
  },

  /**
   * Run `fn` as one job-queue sample wave. Every allowlisted macro receives
   * `beforeSampleJobQueues` / `afterSampleJobQueues` (defaults no-op). Dispatcher
   * must not know adapter cache details. Hooks may be sync or return a Promise
   * (both are awaited). Only adapters whose before completed without throwing
   * receive after (token fencing, including successful null tokens).
   *
   * @template T
   * @param {() => (T|Promise<T>)} fn body for this wave
   * @param {import("./configuration")|null|undefined} [configuration]
   * @returns {Promise<T>} resolves to `fn`'s return value
   */
  async aroundJobQueueSample(fn, configuration) {
    const logger = configuration && configuration.logger
    // Only adapters whose before completed are recorded. If before raises,
    // after is skipped for that adapter (Ruby Plan.around_job_queue_sample).
    const tokens = Object.create(null)

    for (const name of Object.keys(this.ADAPTERS)) {
      try {
        const macro = this.ADAPTERS[name]
        if (macro && typeof macro.beforeSampleJobQueues === "function") {
          tokens[name] = await macro.beforeSampleJobQueues()
        } else {
          tokens[name] = null
        }
      } catch (error) {
        safeLog(
          logger,
          "error",
          `[HireFire] beforeSampleJobQueues for ${JSON.stringify(
            name,
          )} raised ` + formatHookError(error),
        )
      }
    }

    try {
      return await fn()
    } finally {
      for (const name of Object.keys(tokens)) {
        try {
          const macro = this.ADAPTERS[name]
          if (macro && typeof macro.afterSampleJobQueues === "function") {
            await macro.afterSampleJobQueues(tokens[name])
          }
        } catch (error) {
          safeLog(
            logger,
            "error",
            `[HireFire] afterSampleJobQueues for ${JSON.stringify(
              name,
            )} raised ` + formatHookError(error),
          )
        }
      }
    }
  },

  /**
   * Notify every allowlisted macro after fork / abandoned inherited state.
   * Node has no process fork model; keep the fan-out so ports match Ruby.
   *
   * @param {import("./configuration")|null|undefined} [configuration]
   * @returns {Promise<void>}
   */
  async reinitMacrosAfterFork(configuration) {
    const logger = configuration && configuration.logger
    for (const name of Object.keys(this.ADAPTERS)) {
      try {
        const macro = this.ADAPTERS[name]
        if (macro && typeof macro.reinitAfterFork === "function") {
          await macro.reinitAfterFork()
        }
      } catch (error) {
        safeLog(
          logger,
          "error",
          `[HireFire] reinitAfterFork for ${JSON.stringify(name)} raised ` +
            formatHookError(error),
        )
      }
    }
  },

  /**
   * @param {object} entry
   * @param {import("./configuration")} configuration
   * @returns {Promise<void>}
   */
  async execute(entry, configuration) {
    const adapter = String(entry.adapter ?? entry["adapter"] ?? "").trim()
    const strategy = String(entry.strategy ?? entry["strategy"] ?? "").trim()
    const name = String(entry.name ?? entry["name"] ?? "").trim()
    const methodName = STRATEGIES[strategy]
    const logger = configuration.logger

    if (!methodName) {
      safeLog(
        logger,
        "error",
        `[HireFire] Unknown plan strategy ${JSON.stringify(strategy)} for ` +
          `${JSON.stringify(name)}. Entry skipped.`,
      )
      return
    }

    if (!this.knownAdapter(adapter)) {
      safeLog(
        logger,
        "error",
        `[HireFire] Unknown plan adapter ${JSON.stringify(adapter)} for ` +
          `${JSON.stringify(name)}. Entry skipped.`,
      )
      return
    }

    const macro = this.ADAPTERS[adapter]

    if (
      typeof macro.supportsPlanStrategy === "function" &&
      !macro.supportsPlanStrategy(strategy)
    ) {
      safeLog(
        logger,
        "error",
        `[HireFire] Plan adapter ${JSON.stringify(adapter)} does not support ` +
          `strategy ${JSON.stringify(strategy)} for ${JSON.stringify(
            name,
          )}. Entry skipped.`,
      )
      return
    }

    const queues = normalizePlanQueues(
      entry.queues ?? entry["queues"],
      name,
      logger,
    )
    if (queues === null) return

    try {
      const planOpts =
        typeof macro.planOptions === "function"
          ? macro.planOptions(strategy, entry.options ?? entry["options"])
          : {}
      const connOpts =
        typeof macro.planConnectionOptions === "function"
          ? macro.planConnectionOptions()
          : {}
      const options = { ...planOpts, ...connOpts }
      const method = macro[methodName]
      if (typeof method !== "function") {
        safeLog(
          logger,
          "error",
          `[HireFire] Plan adapter ${JSON.stringify(
            adapter,
          )} has no ${methodName}. Entry skipped.`,
        )
        return
      }

      const ok = await sampleJobStrategy(
        configuration,
        name,
        strategy,
        method,
        queues,
        options,
        logger,
      )
      if (!ok) return

      if (typeof macro.jobQueueWorking === "function") {
        await sampleWorking(
          configuration,
          name,
          macro.jobQueueWorking,
          queues,
          options,
          logger,
        )
      }
    } catch (error) {
      const reason =
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error)
      safeLog(
        logger,
        "error",
        `[HireFire] Plan sampler for ${JSON.stringify(name)} raised ${reason}`,
      )
    }
  },
}

/**
 * Primary jql/jqs sample. Returns true when a value was buffered.
 * @returns {Promise<boolean>}
 */
async function sampleJobStrategy(
  configuration,
  name,
  strategy,
  method,
  queues,
  options,
  logger,
) {
  const value = await method(...queues, options)

  if (!validSample(value)) {
    safeLog(
      logger,
      "error",
      `[HireFire] Plan sampler for ${JSON.stringify(name)} returned ` +
        `${formatSampleValue(
          value,
        )}, expected a non-negative number. Sample dropped.`,
    )
    return false
  }

  configuration.buffer.sample(name, strategy, Number(value))
  return true
}

/**
 * Companion in-flight series for adapters that implement jobQueueWorking.
 * Failures log and do not drop the job strategy sample.
 * @returns {Promise<void>}
 */
async function sampleWorking(
  configuration,
  name,
  method,
  queues,
  options,
  logger,
) {
  try {
    const wrk = await method(...queues, options)
    if (!validSample(wrk)) {
      safeLog(
        logger,
        "error",
        `[HireFire] Plan working sampler for ${JSON.stringify(name)} returned ` +
          `${formatSampleValue(
            wrk,
          )}, expected a non-negative number. wrk sample dropped.`,
      )
      return
    }
    configuration.buffer.sample(name, "wrk", Number(wrk))
  } catch (error) {
    const reason =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error)
    safeLog(
      logger,
      "error",
      `[HireFire] Plan working sampler for ${JSON.stringify(
        name,
      )} raised ${reason}`,
    )
  }
}

function libraryLoaded(adapter) {
  const name = String(adapter)
  if (name === "pg_boss") {
    try {
      require.resolve("pg-boss")
      require.resolve("pg")
      return true
    } catch {
      return false
    }
  }
  if (name !== "bullmq" && name !== "bull") return false
  try {
    require.resolve(name)
    return true
  } catch {
    return false
  }
}

function normalizePlanQueues(queues, name, logger) {
  if (queues == null) return []

  if (!Array.isArray(queues)) {
    safeLog(
      logger,
      "error",
      `[HireFire] Plan queues for ${JSON.stringify(
        name,
      )} must be an array. Entry skipped.`,
    )
    return null
  }

  const list = []
  for (const queue of queues) {
    // JSON null → "" (Ruby nil.to_s), then dropped as empty. Never String(null) → "null".
    const qname = queue == null ? "" : String(queue).trim()
    if (!qname || Buffer.byteLength(qname) > MAX_QUEUE_NAME_BYTES) continue
    list.push(qname)
  }

  if (list.length === 0 && queues.length > 0) {
    safeLog(
      logger,
      "error",
      `[HireFire] Plan queue list for ${JSON.stringify(
        name,
      )} had no valid names. Entry skipped.`,
    )
    return null
  }

  if (list.length > MAX_QUEUES) {
    safeLog(
      logger,
      "error",
      `[HireFire] Plan queue list truncated to ${MAX_QUEUES} names.`,
    )
    return list.slice(0, MAX_QUEUES)
  }

  return list
}

function validSample(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
}

function formatSampleValue(value) {
  try {
    const text = value === null ? "null" : typeof value
    let preview = String(value)
    if (Buffer.byteLength(preview) > 64) {
      preview = preview.slice(0, 64) + "…"
    }
    return `${text}(${JSON.stringify(preview)})`
  } catch {
    return typeof value
  }
}

function formatHookError(error) {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`
  }
  return String(error)
}

module.exports = Plan
