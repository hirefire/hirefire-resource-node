const Hooks = {
  planOptions(_strategy, _options) {
    return {}
  },

  planConnectionOptions() {
    return {}
  },

  supportsPlanStrategy(strategy) {
    return require("../plan").knownStrategy(strategy)
  },

  queuesRequired() {
    return false
  },

  beforeSampleJobQueues() {
    return null
  },

  afterSampleJobQueues(_token) {},

  reinitAfterFork() {},

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
