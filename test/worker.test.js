const {
  Worker,
  InvalidDynoNameError,
  MissingDynoFnError,
} = require("../src/worker")

describe("Worker", () => {
  test("setup and methods", () => {
    const worker = new Worker("worker", () => 1 + 1)
    expect(worker.name).toBe("worker")
    expect(worker.value()).resolves.toBe(2)
  })

  test("invalid dyno name error", () => {
    expect(() => new Worker("invalid name")).toThrow(InvalidDynoNameError)
  })

  test("missing dyno function error", () => {
    expect(() => new Worker("worker")).toThrow(MissingDynoFnError)
  })
})
