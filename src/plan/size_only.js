const { JQS } = require("../strategy")

const SizeOnly = {
  supportsPlanStrategy(strategy) {
    return String(strategy) === JQS
  },
}

module.exports = SizeOnly
