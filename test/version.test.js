const VERSION = require("../src/version")

describe("VERSION", () => {
  test("version", () => {
    expect(VERSION).toMatch(/\d+\.\d+\.\d+/)
  })
})
