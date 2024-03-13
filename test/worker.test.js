const {
  Worker,
  InvalidDynoNameError,
  MissingDynoFnError,
} = require("../src/worker")

describe("Worker", () => {
  test("setup and methods", () => {
    const validNames = [
      "worker",
      "worker1",
      "my-worker",
      "my_worker",
      "Worker_123",
      "worker-123",
      "w",
      "a".repeat(30),
    ]

    validNames.forEach((name) => {
      const worker = new Worker("worker", () => 1 + 1)
      expect(worker.name).toBe("worker")
      expect(worker.value()).resolves.toBe(2)
    })
  })

  test("invalid dyno name error", () => {
    const invalidNames = [
      "", // Empty string
      "1worker", // Starts with a digit
      "-worker", // Starts with a dash
      "_worker", // Starts with an underscore
      "worker!", // Contains an invalid character
      " worker", // Starts with a space
      "worker ", // Ends with a space
      "a".repeat(31), // Exceeds maximum length
    ]

    invalidNames.forEach((name) => {
      expect(() => new Worker(name)).toThrow(InvalidDynoNameError)
    })
  })

  test("missing dyno function error", () => {
    expect(() => new Worker("worker")).toThrow(MissingDynoFnError)
  })
})
