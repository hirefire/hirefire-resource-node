require("./support")
const Worker = require("../src/worker")

describe("Worker", () => {
  test("coerces the name to a string", () => {
    expect(new Worker("worker", () => 1).name).toBe("worker")
    expect(new Worker(123, () => 1).name).toBe("123")
  })

  test("sample returns a synchronous sampler value", async () => {
    expect(await new Worker("worker", () => 42).sample()).toBe(42)
  })

  test("sample awaits an async sampler", async () => {
    expect(await new Worker("worker", async () => 7).sample()).toBe(7)
  })
})
