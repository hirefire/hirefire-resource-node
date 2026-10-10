const { presence } = require("./utility")

const ONE_OFF_DYNOS = ["run", "release"]

const Identity = {
  MAX_NAME_BYTES: 128,

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

  oneOff() {
    const name = this.herokuDyno()
    return name != null && ONE_OFF_DYNOS.includes(name.toLowerCase())
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

module.exports = Identity
