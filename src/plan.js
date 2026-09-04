const safeLog = require("./log")
const { formatError } = safeLog
const { validSample, coerceSample, formatSampleValue } = require("./sample")

const STRATEGIES = {
  jql: "jobQueueLatency",
  jqs: "jobQueueSize",
}

const MAX_QUEUES = 64
const MAX_QUEUE_NAME_BYTES = 128

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
    return Object.prototype.hasOwnProperty.call(this.ADAPTERS, String(adapter))
  },

  libraryLoaded(adapter) {
    return libraryLoaded(adapter)
  },

  resetLibraryLoadedCache() {
    resetLibraryLoadedCache()
  },

  executable(adapter) {
    return this.knownAdapter(adapter) && this.libraryLoaded(adapter)
  },

  knownStrategy(strategy) {
    return Object.prototype.hasOwnProperty.call(STRATEGIES, String(strategy))
  },

  supportsStrategy(adapter, strategy) {
    if (!this.knownAdapter(adapter)) return false
    if (!this.knownStrategy(strategy)) return false
    const macro = this.ADAPTERS[String(adapter)]
    if (!macro || typeof macro.supportsPlanStrategy !== "function") return false
    return macro.supportsPlanStrategy(strategy)
  },

  queuesRequired(adapter) {
    if (!this.knownAdapter(adapter)) return false
    const macro = this.ADAPTERS[String(adapter)]
    if (!macro || typeof macro.queuesRequired !== "function") return false
    return Boolean(macro.queuesRequired())
  },

  namedPlanQueues(queues) {
    if (!Array.isArray(queues)) return false
    return queues.some((queue) => {
      const name = queue == null ? "" : String(queue).trim()
      return name.length > 0 && Buffer.byteLength(name) <= MAX_QUEUE_NAME_BYTES
    })
  },

  sampleableEntry(entry) {
    const adapter = entry.adapter
    const strategy = entry.strategy
    if (
      !this.executable(adapter) ||
      !this.supportsStrategy(adapter, strategy)
    ) {
      return false
    }
    if (!this.queuesRequired(adapter)) return true
    return this.namedPlanQueues(entry.queues)
  },

  async aroundJobQueueSample(fn, configuration) {
    const logger = configuration && configuration.logger
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

  async execute(entry, configuration, live) {
    const adapter = String(entry.adapter ?? "").trim()
    const strategy = String(entry.strategy ?? "").trim()
    const name = String(entry.name ?? "").trim()
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

    const queues = normalizePlanQueues(entry.queues, name, logger)
    if (queues === null) return

    if (this.queuesRequired(adapter) && queues.length === 0) {
      safeLog(
        logger,
        "error",
        `[HireFire] Plan adapter ${JSON.stringify(adapter)} for ` +
          `${JSON.stringify(name)} requires named queues. Entry skipped.`,
      )
      return
    }

    try {
      const options = {
        ...macro.planOptions(strategy, entry.options),
        ...macro.planConnectionOptions(),
      }
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

      await sampleJobStrategy(
        configuration,
        name,
        strategy,
        method,
        queues,
        options,
        logger,
        live,
      )

      if (typeof macro.jobQueueWorking === "function") {
        await sampleWorking(
          configuration,
          name,
          macro.jobQueueWorking,
          queues,
          options,
          logger,
          live,
        )
      }
    } catch (error) {
      const reason = formatError(error)
      safeLog(
        logger,
        "error",
        `[HireFire] Plan sampler for ${JSON.stringify(name)} raised ${reason}`,
      )
    }
  },
}

async function sampleJobStrategy(
  configuration,
  name,
  strategy,
  method,
  queues,
  options,
  logger,
  live,
) {
  try {
    const value = await method(...queues, options)
    if (live && !live()) return false

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

    configuration.buffer.sample(name, strategy, coerceSample(value))
    return true
  } catch (error) {
    const reason = formatError(error)
    safeLog(
      logger,
      "error",
      `[HireFire] Plan sampler for ${JSON.stringify(name)} raised ${reason}`,
    )
    return false
  }
}

async function sampleWorking(
  configuration,
  name,
  method,
  queues,
  options,
  logger,
  live,
) {
  try {
    const wrk = await method(...queues, options)
    if (live && !live()) return
    if (!validSample(wrk)) {
      safeLog(
        logger,
        "error",
        `[HireFire] Plan working sampler for ${JSON.stringify(
          name,
        )} returned ` +
          `${formatSampleValue(
            wrk,
          )}, expected a non-negative number. wrk sample dropped.`,
      )
      return
    }
    configuration.buffer.sample(name, "wrk", coerceSample(wrk))
  } catch (error) {
    const reason = formatError(error)
    safeLog(
      logger,
      "error",
      `[HireFire] Plan working sampler for ${JSON.stringify(
        name,
      )} raised ${reason}`,
    )
  }
}

const libraryLoadedCache = new Map()

function libraryLoaded(adapter) {
  const name = String(adapter)
  if (libraryLoadedCache.has(name)) return libraryLoadedCache.get(name)
  const loaded = detectLibrary(name)
  libraryLoadedCache.set(name, loaded)
  return loaded
}

function resetLibraryLoadedCache() {
  libraryLoadedCache.clear()
}

function detectLibrary(name) {
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
    require.resolve("ioredis")
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

function formatHookError(error) {
  return formatError(error)
}

module.exports = Plan
