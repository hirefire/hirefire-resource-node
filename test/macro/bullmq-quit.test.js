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
      lindex: jest.fn().mockReturnThis(),
      llen: jest.fn().mockReturnThis(),
      zcount: jest.fn().mockReturnThis(),
      exec,
    }
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      scan: jest.fn().mockResolvedValue(["0", []]),
      quit,
    }))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  test("jobQueueSize quits Redis when all-queues enumeration fails", async () => {
    const scan = jest.fn().mockRejectedValueOnce(new Error("redis down"))
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      scan,
      quit,
    }))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize enumerates queues with SCAN not KEYS", async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce([
        "7",
        ["bull:default:wait", "bull:mailer:active", "bull:other:meta"],
      ])
      .mockResolvedValueOnce(["0", ["bull:default:delayed"]])
    exec.mockResolvedValue([
      [null, null],
      [null, 0],
      [null, 0],
      [null, 0],
      [null, null],
      [null, 0],
      [null, 0],
      [null, 0],
    ])
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      scan,
      quit,
    }))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)
    expect(scan).toHaveBeenCalled()
    expect(pipeline.lindex).toHaveBeenCalledWith("bull:default:wait", -1)
    expect(pipeline.lindex).toHaveBeenCalledWith("bull:mailer:wait", -1)
    expect(pipeline.lindex).toHaveBeenCalledTimes(2)
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

  test("jobQueueSize disconnects when quit rejects after a pipeline failure", async () => {
    const disconnect = jest.fn()
    quit.mockRejectedValueOnce(new Error("quit failed"))
    exec.mockRejectedValueOnce(new Error("redis down"))
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      quit,
      disconnect,
    }))

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })
})
