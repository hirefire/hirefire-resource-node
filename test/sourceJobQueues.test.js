const JobQueues = require("../src/source/jobQueues")
const JobQueue = require("../src/source/jobQueue")

describe("JobQueues", () => {
  test("any tells whether a job queue was added", () => {
    const jobQueues = new JobQueues()
    expect(jobQueues.any()).toBe(false)

    jobQueues.add(new JobQueue("worker", () => 1))
    expect(jobQueues.any()).toBe(true)
  })

  test("find by name returns null for a name that was not added", () => {
    const jobQueues = new JobQueues()
    jobQueues.add(new JobQueue("worker", () => 1))

    expect(jobQueues.findByName("mailer")).toBeNull()
    expect(new JobQueues().findByName("worker")).toBeNull()
  })

  test("find by name ignores case and keeps the name as it was declared", () => {
    const jobQueues = new JobQueues()
    const worker = new JobQueue("Worker", () => 1)
    jobQueues.add(worker)

    expect(jobQueues.findByName("worker")).toBe(worker)
    expect(jobQueues.findByName("WORKER")).toBe(worker)
    expect(jobQueues.findByName("worker").name).toBe("Worker")
  })

  test("the job queues are iterated in the order they were added", () => {
    const jobQueues = new JobQueues()
    jobQueues.add(new JobQueue("worker", () => 1))
    jobQueues.add(new JobQueue("mailer", () => 2))

    expect([...jobQueues].map((jobQueue) => jobQueue.name)).toEqual([
      "worker",
      "mailer",
    ])
  })
})
