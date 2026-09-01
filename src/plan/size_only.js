const SizeOnly = {
  supportsPlanStrategy(strategy) {
    return String(strategy) === "jqs"
  },
}

module.exports = SizeOnly
