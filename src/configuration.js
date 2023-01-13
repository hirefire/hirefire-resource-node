const { Web } = require("./web")
const { Worker } = require("./worker")

class Configuration {
  constructor() {
    this.web = null
    this.workers = []
    this.logger = console
  }

  dyno(name, fn) {
    if (name === "web") {
      this.web = new Web(this)
    } else {
      this.workers.push(new Worker(name, fn))
    }
  }
}

module.exports = Configuration
