const HireFire = require("../src")
const Configuration = require("../src/configuration")

describe("HireFire singleton", () => {
  test("default configuration", () => {
    expect(HireFire.configuration).toBeInstanceOf(Configuration)
  })
})
