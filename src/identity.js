// Resolves this process's name (to match against a declared dyno name). First
// non-empty source wins; null means unresolved.
const Identity = {
  resolve() {
    return this.explicit() || this.herokuDyno() || this.renderService() || null
  },

  explicit() {
    return presence(process.env.HIREFIRE_SERVICE_NAME)
  },

  // DYNO is "web.1" on Cedar, a pod name like "web-5fb9c979-lft2l" on Fir.
  // Strip the two trailing "-<alnum>" segments, keeping any dash inside the name.
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

  // True when an explicit name disagrees with the DYNO prefix: a dashboard-set
  // (app-wide) HIREFIRE_SERVICE_NAME would make every dyno identify the same.
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
