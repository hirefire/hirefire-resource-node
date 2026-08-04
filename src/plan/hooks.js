const KNOWN_STRATEGIES = new Set(["jql", "jqs"])

/**
 * Uniform plan hooks for every queue macro. Plan always calls these; adapters
 * override when they accept lease options, need connection options, or hold
 * sample-wave / process-local state (defaults are no-ops so ports stay aligned
 * with Ruby even when no adapter uses the lifecycle yet).
 */
const Hooks = {
  /**
   * Filter/coerce plan JSON `options` for `strategy` (`"jql"` / `"jqs"`).
   *
   * @param {string} _strategy
   * @param {*} _options
   * @returns {object}
   */
  planOptions(_strategy, _options) {
    return {}
  },

  /**
   * Connection-related options from the environment.
   *
   * @returns {object}
   */
  planConnectionOptions() {
    return {}
  },

  /**
   * Whether this adapter can sample `strategy` (`"jql"` / `"jqs"`).
   *
   * @param {string|symbol} strategy
   * @returns {boolean}
   */
  supportsPlanStrategy(strategy) {
    return KNOWN_STRATEGIES.has(String(strategy))
  },

  /**
   * Open process-local state for one Dispatcher job-queue sample wave.
   * Default is a no-op. Adapters with sample-scoped caches override and may
   * return an opaque token for {@link Hooks.afterSampleJobQueues}.
   *
   * Called for every allowlisted macro on each job-queue sample wave, whether
   * or not that adapter appears in the current lease plan. May be sync or
   * return a Promise (Plan awaits either).
   *
   * @returns {*|null|Promise<*|null>} opaque token passed to `afterSampleJobQueues`
   */
  beforeSampleJobQueues() {
    return null
  },

  /**
   * Close process-local sample-wave state opened by
   * {@link Hooks.beforeSampleJobQueues}. Default is a no-op. Called from
   * `finally` even when a sampler raises. May be sync or return a Promise.
   *
   * @param {*} [_token] value returned by `beforeSampleJobQueues`
   * @returns {void|Promise<void>}
   */
  afterSampleJobQueues(_token) {},

  /**
   * Reset process-local macro state after fork or abandoned inherited state.
   * Default is a no-op. Node has no process fork model; the hook still exists
   * so the surface matches Ruby/Python when a consumer appears. May be sync or
   * return a Promise.
   *
   * @returns {void|Promise<void>}
   */
  reinitAfterFork() {},

  /**
   * Slice and coerce lease `options` using a strategy-keyed schema.
   *
   * @param {string|symbol} strategy
   * @param {*} options
   * @param {Record<string, Record<string, string>>} schema
   * @returns {object}
   */
  extractPlanOptions(strategy, options, schema) {
    if (!options || typeof options !== "object" || Array.isArray(options)) {
      return {}
    }

    const fields = schema[String(strategy)]
    if (!fields) return {}

    const out = {}
    for (const [key, value] of Object.entries(options)) {
      const type = fields[key]
      if (!type) continue
      const coerced = Hooks.coercePlanValue(type, value)
      if (coerced !== null && coerced !== undefined) {
        out[key] = coerced
      }
    }
    return out
  },

  /**
   * Coerce a single plan option value. Returns `null` when not acceptable.
   *
   * @param {string} type - `"boolean"` or `"non_negative_integer"`
   * @param {*} value
   * @returns {*|null}
   */
  coercePlanValue(type, value) {
    if (type === "boolean") {
      if (value === true) return true
      if (value === false) return false
      return null
    }
    if (type === "non_negative_integer") {
      if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
        return value
      }
      if (typeof value === "string") {
        if (!/^[+-]?\d+$/.test(value)) return null
        const int = parseInt(value, 10)
        if (Number.isFinite(int) && int >= 0) return int
      }
      return null
    }
    return null
  },
}

module.exports = Hooks
