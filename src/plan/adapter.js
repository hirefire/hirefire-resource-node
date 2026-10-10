const { installed } = require("../optional")
const { JQS } = require("../strategy")
const { presence } = require("../utility")

class Adapter {
  constructor({ macro, packages, strategies, environment = {} }) {
    this._macro = macro
    this._loaded = null
    this.packages = packages
    this.strategies = strategies
    this.environment = environment
  }

  get macro() {
    return this._macro()
  }

  libraryLoaded() {
    this._loaded ??= this.packages.every(installed)
    return this._loaded
  }

  supports(strategy) {
    return this.strategies.includes(strategy)
  }

  options(strategy, raw) {
    const skipWorking = strategy === JQS ? raw?.skip_working : undefined
    return typeof skipWorking === "boolean" ? { skipWorking } : {}
  }

  connectionOptions() {
    const options = {}
    for (const [option, variable] of Object.entries(this.environment)) {
      const value = presence(process.env[variable])
      if (value) options[option] = value
    }
    return options
  }
}

module.exports = Adapter
