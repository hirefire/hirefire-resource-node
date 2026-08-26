const JobQueue = require("../src/source/jobQueue")

describe("JobQueue", () => {
  test("name", () => {
    expect(new JobQueue("worker", () => 1 + 1).name).toBe("worker")
  })

  test("sample returns the sampler result", async () => {
    expect(await new JobQueue("worker", () => 1).sample()).toBe(1)
  })

  test("name normalized to string", () => {
    expect(new JobQueue(123, () => 1).name).toBe("123")
  })

  test("sample awaits an async sampler", async () => {
    expect(await new JobQueue("worker", async () => 7).sample()).toBe(7)
  })
})
