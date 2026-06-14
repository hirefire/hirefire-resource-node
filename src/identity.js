// Resolves the name of the process this code is running in, so collectors can
// tell whether they should report under a given declared dyno name. First
// non-empty source wins; null means unresolved.
const Identity = {
  resolve() {
    return this.explicit() || this.herokuDyno() || this.renderService() || null
  },

  explicit() {
    return presence(process.env.HIREFIRE_SERVICE_NAME)
  },

  // Heroku sets DYNO per generation: Cedar uses "web.1" (process type before
  // the first "."); Fir uses Kubernetes pod names like "web-5fb9c979-lft2l".
  // Stripping the two trailing "-<alnum>" segments, rather than splitting on
  // the first "-", keeps any dash inside a process name intact.
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

  // Heroku config vars are app-wide, so a dashboard-set HIREFIRE_SERVICE_NAME
  // makes every dyno identify as the same name. True when an explicit name
  // disagrees with the DYNO prefix. Case-insensitive, matching the identity
  // gates: names differing only in case gate identically.
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
