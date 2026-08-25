const JobQueue = require("../src/source/jobQueue")

describe("JobQueue", () => {
  test("coerces the name to a string", () => {
    expect(new JobQueue("worker", () => 1).name).toBe("worker")
    expect(new JobQueue(123, () => 1).name).toBe("123")
  })

  test("sample returns a synchronous sampler value", async () => {
    expect(await new JobQueue("worker", () => 42).sample()).toBe(42)
  })

  test("sample awaits an async sampler", async () => {
    expect(await new JobQueue("worker", async () => 7).sample()).toBe(7)
  })
})
