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
    get bullmq() {
      return require("./macro/bullmq")
    },
  },

  STRATEGIES,

  MAX_QUEUES,
  MAX_QUEUE_NAME_BYTES,

  anyAllowlistedJobQueueLibraryLoaded() {
    return libraryLoaded("bullmq")
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
        return
      }

      configuration.buffer.sample(name, strategy, Number(value))
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

function libraryLoaded(adapter) {
  if (String(adapter) !== "bullmq") return false
  try {
    require.resolve("bullmq")
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

module.exports = Plan
