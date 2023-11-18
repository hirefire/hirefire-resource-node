const HireFire = require("../src/hirefire")
const Configuration = require("../src/configuration")

describe("HireFire", () => {
  test("configure yields configuration", () => {
    const hirefire = new HireFire()
    let receivedConfig
    hirefire.configure((config) => {
      receivedConfig = config
    })
    expect(receivedConfig).toBeInstanceOf(Configuration)
    expect(receivedConfig).toBe(hirefire.configuration)
  })
})
