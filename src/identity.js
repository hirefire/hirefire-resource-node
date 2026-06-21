const Identity = {
  resolve() {
    return this.explicit() || this.herokuDyno() || this.renderService() || null
  },

  explicit() {
    return presence(process.env.HIREFIRE_SERVICE_NAME)
  },

  herokuDyno() {
    const dyno = presence(process.env.DYNO)
    if (!dyno) return null

    if (dyno.includes(".")) {
      return dyno.split(".")[0]
    } else {
      return dyno.replace(/-[a-z0-9]+-[a-z0-9]+$/, "")
    }
  },

  renderService() {
    return presence(process.env.RENDER_SERVICE_NAME)
  },

  herokuConflict() {
    const explicit = this.explicit()
    const dyno = this.herokuDyno()
    return Boolean(
      explicit && dyno && explicit.toLowerCase() !== dyno.toLowerCase(),
    )
  },
}

function presence(value) {
  return value && value.length > 0 ? value : null
}

module.exports = Identity
