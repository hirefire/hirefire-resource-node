class InvalidDynoNameError extends Error {
  constructor(message) {
    super(message)
    this.name = "InvalidDynoNameError"
  }
}

class MissingDynoFnError extends Error {
  constructor(message) {
    super(message)
    this.name = "MissingDynoFnError"
  }
}

class Worker {
  static PROCESS_NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]{0,29}$/

  constructor(name, fn) {
    this._validate(name, fn)
    this.name = name
    this._fn = fn
  }

  async value() {
    return this._fn()
  }

  _validate(name, fn) {
    if (!Worker.PROCESS_NAME_PATTERN.test(name || "")) {
      throw new InvalidDynoNameError(
        `Invalid name for new Worker(${name}, fn). ` +
          "Ensure it matches the Procfile process name (i.e. web, worker).",
      )
    }

    if (!fn || typeof fn !== "function") {
      throw new MissingDynoFnError(
        `Missing function for new Worker(${name}, fn). ` +
          "Ensure that you provide a function that returns the job queue metric.",
      )
    }
  }
}

module.exports = { Worker, InvalidDynoNameError, MissingDynoFnError }
