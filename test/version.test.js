const VERSION = require("../src/version")

describe("VERSION", () => {
  test("version is a stable or npm rc semver", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(-rc\.\d+)?$/)
  })
})
