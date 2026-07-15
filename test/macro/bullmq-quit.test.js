jest.mock(
  "ioredis",
  () => {
    return jest.fn()
  },
  { virtual: true },
)

const IORedis = require("ioredis")
const { jobQueueSize } = require("../../src/macro/bullmq")

describe("BullMQ connection lifecycle", () => {
  let quit
  let exec

  beforeEach(() => {
    quit = jest.fn().mockResolvedValue("OK")
    exec = jest.fn()
    const pipeline = {
      keys: jest.fn().mockReturnThis(),
      lindex: jest.fn().mockReturnThis(),
      llen: jest.fn().mockReturnThis(),
      zcount: jest.fn().mockReturnThis(),
      exec,
    }
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      quit,
    }))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  test("jobQueueSize quits Redis when all-queues enumeration fails", async () => {
    exec.mockRejectedValueOnce(new Error("redis down"))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize quits Redis when the size pipeline fails", async () => {
    exec.mockRejectedValueOnce(new Error("size pipeline failed"))

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("size pipeline failed")
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
