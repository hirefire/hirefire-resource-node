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
  let pipeline

  beforeEach(() => {
    quit = jest.fn().mockResolvedValue("OK")
    exec = jest.fn()
    pipeline = {
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

  test("jobQueueSize trims and de-duplicates queue names", async () => {
    exec.mockResolvedValueOnce([
      [null, null],
      [null, 1],
      [null, 0],
      [null, 0],
    ])

    await expect(
      jobQueueSize("default", " default ", "default", {
        connection: "redis://localhost:6379/0",
      }),
    ).resolves.toBe(1)
    expect(pipeline.llen).toHaveBeenCalledTimes(2)
    expect(pipeline.lindex).toHaveBeenCalledTimes(1)
    expect(pipeline.zcount).toHaveBeenCalledTimes(1)
  })
})
