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

    let name
    if (dyno.includes(".")) {
      name = dyno.split(".")[0]
    } else {
      name = dyno.replace(/-[A-Za-z0-9]+-[A-Za-z0-9]+$/, "")
    }
    return presence(name)
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

  platformHttpRole() {
    return this.herokuWebProcess() || this.renderWebService()
  },

  herokuWebProcess() {
    const name = this.herokuDyno()
    return name != null && name.toLowerCase() === "web"
  },

  renderWebService() {
    const type = presence(process.env.RENDER_SERVICE_TYPE)
    return type != null && type.toLowerCase() === "web"
  },
}

function presence(value) {
  if (value == null) return null
  const stripped = String(value).trim()
  return stripped.length > 0 ? stripped : null
}

module.exports = Identity
