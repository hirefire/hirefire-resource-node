const cluster = require("cluster")
const HireFire = require("../src")
const Configuration = require("../src/configuration")

describe("HireFire singleton", () => {
  test("default configuration", () => {
    expect(HireFire.configuration).toBeInstanceOf(Configuration)
  })

  test("a second copy of the client in one process is the same client", () => {
    const listeners = cluster.listenerCount("fork")
    jest.resetModules()

    const copy = require("../src")

    expect(copy).toBe(HireFire)
    expect(cluster.listenerCount("fork")).toBe(listeners)
  })

  test("a copy of another version is a client of its own", () => {
    jest.resetModules()
    jest.doMock("../src/version", () => "0.0.0-other")

    const other = require("../src")

    expect(other).not.toBe(HireFire)
    expect(other.configuration).not.toBe(HireFire.configuration)
    expect(require("../src")).toBe(other)
  })

  test("the client listens for the first fork of its process", () => {
    expect(cluster.listenerCount("fork")).toBeGreaterThanOrEqual(1)
  })
})
