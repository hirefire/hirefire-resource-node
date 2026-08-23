jest.mock(
  "ioredis",
  () => {
    return jest.fn()
  },
  { virtual: true },
)

const IORedis = require("ioredis")
const { jobQueueSize, jobQueueWorking } = require("../../src/macro/bullmq")

function emptyQueueResults(count = 1) {
  const rows = []
  for (let i = 0; i < count; i++) {
    rows.push([null, null], [null, 0], [null, 0], [null, 0], [null, 0])
  }
  return rows
}

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
      zcard: jest.fn().mockReturnThis(),
      exec,
    }
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      scan: jest.fn().mockResolvedValue(["0", []]),
      quit,
      on: jest.fn(),
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
      on: jest.fn(),
    }))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize registers error handler and sample timeouts", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    const on = jest.fn()
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      scan: jest.fn().mockResolvedValue(["0", []]),
      quit,
      on,
    }))

    await jobQueueSize("default", { connection: "redis://localhost:6379/0" })

    expect(on).toHaveBeenCalledWith("error", expect.any(Function))
    expect(IORedis).toHaveBeenCalledWith(
      "redis://localhost:6379/0",
      expect.objectContaining({
        maxRetriesPerRequest: 1,
        connectTimeout: 5000,
        commandTimeout: 5000,
        retryStrategy: expect.any(Function),
      }),
    )
  })

  test("jobQueueSize lets caller connectionOptions override sample defaults", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      quit,
      on: jest.fn(),
    }))

    await jobQueueSize("default", {
      connection: "redis://localhost:6379/0",
      connectionOptions: { connectTimeout: 1234, maxRetriesPerRequest: 3 },
    })

    expect(IORedis).toHaveBeenCalledWith(
      "redis://localhost:6379/0",
      expect.objectContaining({
        connectTimeout: 1234,
        maxRetriesPerRequest: 3,
        commandTimeout: 5000,
      }),
    )
  })

  test("jobQueueSize enumerates queues with SCAN not KEYS", async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce([
        "7",
        ["bull:default:wait", "bull:mailer:active", "bull:other:meta"],
      ])
      .mockResolvedValueOnce(["0", ["bull:default:delayed"]])
    exec.mockResolvedValue(emptyQueueResults(2))
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      scan,
      quit,
      on: jest.fn(),
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
    expect(pipeline.zcard).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize counts prioritized and paused, excludes active", async () => {
    const frozenNow = 1_700_000_000_000
    const expectedDelayedUpper = (frozenNow + 1) * 0x1000 - 1
    jest.spyOn(Date, "now").mockReturnValue(frozenNow)
    exec.mockResolvedValueOnce([
      [null, null],
      [null, 1],
      [null, 2],
      [null, 4],
      [null, 5],
    ])

    try {
      await expect(
        jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
      ).resolves.toBe(12)
      expect(pipeline.llen).toHaveBeenCalledWith("bull:default:wait")
      expect(pipeline.llen).toHaveBeenCalledWith("bull:default:paused")
      expect(pipeline.llen).not.toHaveBeenCalledWith("bull:default:active")
      expect(pipeline.zcount).toHaveBeenCalledWith(
        "bull:default:delayed",
        "-inf",
        expectedDelayedUpper,
      )
      expect(pipeline.zcard).toHaveBeenCalledWith("bull:default:prioritized")
    } finally {
      Date.now.mockRestore()
    }
  })

  test("jobQueueSize subtracts wait marker when last entry is 0:", async () => {
    exec.mockResolvedValueOnce([
      [null, "0:123"],
      [null, 1],
      [null, 0],
      [null, 0],
      [null, 0],
    ])
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)

    exec.mockResolvedValueOnce([
      [null, "0:123"],
      [null, 2],
      [null, 0],
      [null, 0],
      [null, 0],
    ])
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(1)
  })

  test("jobQueueSize treats pipeline field errors as zero", async () => {
    exec.mockResolvedValueOnce([
      [null, null],
      [null, 1],
      [new Error("nope"), null],
      [null, 2],
      [null, 0],
    ])

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(3)
  })

  test("jobQueueSize disconnects when quit rejects after a pipeline failure", async () => {
    const disconnect = jest.fn()
    quit.mockRejectedValueOnce(new Error("quit failed"))
    exec.mockRejectedValueOnce(new Error("redis down"))
    IORedis.mockImplementation(() => ({
      pipeline: () => pipeline,
      quit,
      disconnect,
      on: jest.fn(),
    }))

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test("jobQueueWorking quits Redis after sampling", async () => {
    exec.mockResolvedValueOnce([[null, 2]])
    await expect(
      jobQueueWorking("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(2)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(pipeline.llen).toHaveBeenCalledWith("bull:default:active")
  })

  test("jobQueueWorking quits Redis when sampling fails", async () => {
    exec.mockRejectedValueOnce(new Error("redis down"))
    await expect(
      jobQueueWorking("default", { connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
  })
})
