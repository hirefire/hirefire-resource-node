const Configuration = require("./configuration")

class HireFire {
  constructor() {
    this.configuration = new Configuration()
  }

  configure(fn) {
    fn(this.configuration)
  }
}

module.exports = HireFire
