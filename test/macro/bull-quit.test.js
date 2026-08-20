function emptyQueueResults(count = 1) {
  const rows = []
  for (let i = 0; i < count; i++) {
    rows.push([null, 0], [null, 0], [null, 0])
  }
  return rows
}

/**
 * Load jobQueueSize against a fresh virtual ioredis mock.
 * Core cell has no ioredis package (virtual required). Combined runs with
 * bull.test.js may have already resolved real ioredis: resetModules + doMock
 * so the sampler always hits this mock, not the real client.
 */
function loadBullWithMockedIORedis(clientFactory) {
  jest.resetModules()
  const IORedis = jest.fn().mockImplementation(clientFactory)
  jest.doMock("ioredis", () => IORedis, { virtual: true })
  try {
    const resolved = require.resolve("ioredis")
    jest.doMock(resolved, () => IORedis)
  } catch {}
  const { jobQueueSize } = require("../../src/macro/bull")
  return { IORedis, jobQueueSize }
}

describe("Bull connection lifecycle", () => {
  let quit
  let exec
  let pipeline
  let IORedis
  let jobQueueSize

  function defaultClient() {
    return {
      pipeline: () => pipeline,
      scan: jest.fn().mockResolvedValue(["0", []]),
      quit,
      on: jest.fn(),
    }
  }

  beforeEach(() => {
    quit = jest.fn().mockResolvedValue("OK")
    exec = jest.fn()
    pipeline = {
      llen: jest.fn().mockReturnThis(),
      zcount: jest.fn().mockReturnThis(),
      exec,
    }
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(defaultClient))
  })

  afterEach(() => {
    jest.resetAllMocks()
    jest.restoreAllMocks()
  })

  test("jobQueueSize quits Redis when all-queues enumeration fails", async () => {
    const scan = jest.fn().mockRejectedValueOnce(new Error("redis down"))
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      scan,
      quit,
      on: jest.fn(),
    })))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize registers error handler and sample timeouts", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    const on = jest.fn()
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      scan: jest.fn().mockResolvedValue(["0", []]),
      quit,
      on,
    })))

    await jobQueueSize("default", { connection: "redis://localhost:6379/0" })

    expect(on).toHaveBeenCalledWith("error", expect.any(Function))
    expect(quit).toHaveBeenCalledTimes(1)
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
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      quit,
      on: jest.fn(),
    })))

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
      .mockResolvedValueOnce([
        "0",
        ["bull:default:delayed", "bull:prio:priority"],
      ])
    exec.mockResolvedValue(emptyQueueResults(3))
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      scan,
      quit,
      on: jest.fn(),
    })))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)
    expect(scan).toHaveBeenCalledWith("0", "MATCH", "bull:*", "COUNT", 100)
    expect(scan).toHaveBeenCalledWith("7", "MATCH", "bull:*", "COUNT", 100)
    expect(pipeline.llen).toHaveBeenCalledWith("bull:default:wait")
    expect(pipeline.llen).toHaveBeenCalledWith("bull:mailer:wait")
    expect(pipeline.llen).toHaveBeenCalledWith("bull:prio:wait")
    expect(pipeline.llen).toHaveBeenCalledTimes(6)
    expect(pipeline.zcount).toHaveBeenCalledTimes(3)
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
    expect(pipeline.zcount).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize counts wait+paused+due delayed only", async () => {
    const frozenNow = 1_700_000_000_000
    const expectedDelayedUpper = (frozenNow + 1) * 0x1000 - 1
    jest.spyOn(Date, "now").mockReturnValue(frozenNow)
    exec.mockResolvedValueOnce([
      [null, 1],
      [null, 2],
      [null, 4],
    ])

    try {
      await expect(
        jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
      ).resolves.toBe(7)
      expect(pipeline.llen).toHaveBeenCalledWith("bull:default:wait")
      expect(pipeline.llen).toHaveBeenCalledWith("bull:default:paused")
      expect(pipeline.llen).not.toHaveBeenCalledWith("bull:default:active")
      expect(pipeline.zcount).toHaveBeenCalledWith(
        "bull:default:delayed",
        "-inf",
        expectedDelayedUpper,
      )
      expect(quit).toHaveBeenCalledTimes(1)
    } finally {
      Date.now.mockRestore()
    }
  })

  test("jobQueueSize treats pipeline field errors as zero", async () => {
    exec.mockResolvedValueOnce([
      [null, 1],
      [new Error("nope"), null],
      [null, 2],
    ])

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(3)
  })

  test("jobQueueSize disconnects when quit rejects after a pipeline failure", async () => {
    const disconnect = jest.fn()
    quit.mockRejectedValueOnce(new Error("quit failed"))
    exec.mockRejectedValueOnce(new Error("redis down"))
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      quit,
      disconnect,
      on: jest.fn(),
    })))

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).rejects.toThrow("redis down")
    expect(quit).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize returns 0 when pipeline.exec yields null or empty", async () => {
    exec.mockResolvedValueOnce(null)
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)
    expect(quit).toHaveBeenCalledTimes(1)

    exec.mockResolvedValueOnce([])
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)
    expect(quit).toHaveBeenCalledTimes(2)
  })

  test("jobQueueSize opens object-form connection as single constructor arg", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      quit,
      on: jest.fn(),
    })))

    await jobQueueSize("default", {
      connection: { host: "10.0.0.5", port: 6380, db: 2 },
      connectionOptions: { connectTimeout: 999 },
    })

    expect(IORedis).toHaveBeenCalledTimes(1)
    expect(IORedis.mock.calls[0]).toHaveLength(1)
    expect(IORedis).toHaveBeenCalledWith(
      expect.objectContaining({
        host: "10.0.0.5",
        port: 6380,
        db: 2,
        connectTimeout: 999,
        maxRetriesPerRequest: 1,
        commandTimeout: 5000,
        retryStrategy: expect.any(Function),
      }),
    )
  })

  test("jobQueueSize sample retryStrategy bails after two retries", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    await jobQueueSize("default", { connection: "redis://localhost:6379/0" })
    const opts = IORedis.mock.calls[0][1]
    expect(opts.retryStrategy(1)).toBe(50)
    expect(opts.retryStrategy(2)).toBe(100)
    expect(opts.retryStrategy(3)).toBeNull()
  })

  test("jobQueueSize drops blank, null, and whitespace queue names", async () => {
    exec.mockResolvedValueOnce([
      [null, 4],
      [null, 0],
      [null, 0],
    ])

    await expect(
      jobQueueSize("default", "  ", "", null, undefined, {
        connection: "redis://localhost:6379/0",
      }),
    ).resolves.toBe(4)
    expect(pipeline.llen).toHaveBeenCalledTimes(2)
    expect(pipeline.llen).toHaveBeenCalledWith("bull:default:wait")
    expect(pipeline.llen).toHaveBeenCalledWith("bull:default:paused")
    expect(pipeline.zcount).toHaveBeenCalledTimes(1)
    expect(pipeline.llen).not.toHaveBeenCalledWith("bull: :wait")
    expect(pipeline.llen).not.toHaveBeenCalledWith("bull:null:wait")
  })

  test("jobQueueSize sums multi-queue pipeline groups", async () => {
    const frozenNow = 1_700_000_000_000
    const expectedDelayedUpper = (frozenNow + 1) * 0x1000 - 1
    jest.spyOn(Date, "now").mockReturnValue(frozenNow)
    exec.mockResolvedValueOnce([
      [null, 1],
      [null, 0],
      [null, 2],
      [null, 4],
      [null, 1],
      [null, 0],
    ])

    try {
      await expect(
        jobQueueSize("default", "mailer", {
          connection: "redis://localhost:6379/0",
        }),
      ).resolves.toBe(8)
      expect(pipeline.llen).toHaveBeenCalledWith("bull:default:wait")
      expect(pipeline.llen).toHaveBeenCalledWith("bull:default:paused")
      expect(pipeline.llen).toHaveBeenCalledWith("bull:mailer:wait")
      expect(pipeline.llen).toHaveBeenCalledWith("bull:mailer:paused")
      expect(pipeline.zcount).toHaveBeenCalledWith(
        "bull:default:delayed",
        "-inf",
        expectedDelayedUpper,
      )
      expect(pipeline.zcount).toHaveBeenCalledWith(
        "bull:mailer:delayed",
        "-inf",
        expectedDelayedUpper,
      )
      expect(pipeline.llen).toHaveBeenCalledTimes(4)
      expect(pipeline.zcount).toHaveBeenCalledTimes(2)
    } finally {
      Date.now.mockRestore()
    }
  })

  test("jobQueueSize coerces non-finite pipeline values to zero", async () => {
    exec.mockResolvedValueOnce([
      [null, null],
      [null, "x"],
      [null, 5],
    ])
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(5)

    exec.mockResolvedValueOnce([
      [null, null],
      [null, undefined],
      [null, 7],
    ])
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(7)
  })

  test("jobQueueSize discovers queues from active-only and priority-only SCAN keys", async () => {
    const scan = jest
      .fn()
      .mockResolvedValueOnce([
        "0",
        ["bull:only-active:active", "bull:only-prio:priority"],
      ])
    exec.mockResolvedValue(emptyQueueResults(2))
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      scan,
      quit,
      on: jest.fn(),
    })))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)
    expect(scan).toHaveBeenCalledWith("0", "MATCH", "bull:*", "COUNT", 100)
    expect(pipeline.llen).toHaveBeenCalledWith("bull:only-active:wait")
    expect(pipeline.llen).toHaveBeenCalledWith("bull:only-prio:wait")
    expect(pipeline.llen).toHaveBeenCalledTimes(4)
    expect(pipeline.zcount).toHaveBeenCalledTimes(2)
  })

  test("jobQueueSize SCAN ignores completed/failed/repeat-only and never uses KEYS", async () => {
    const keys = jest.fn()
    const scan = jest
      .fn()
      .mockResolvedValueOnce([
        "0",
        [
          "bull:done-only:completed",
          "bull:fail-only:failed",
          "bull:repeat-only:repeat",
          "bull:meta-only:meta-paused",
          "bull:real:wait",
        ],
      ])
    exec.mockResolvedValue(emptyQueueResults(1))
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      scan,
      keys,
      quit,
      on: jest.fn(),
    })))

    await expect(
      jobQueueSize({ connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(0)
    expect(keys).not.toHaveBeenCalled()
    expect(scan).toHaveBeenCalledTimes(1)
    expect(pipeline.llen).toHaveBeenCalledWith("bull:real:wait")
    expect(pipeline.llen).toHaveBeenCalledWith("bull:real:paused")
    expect(pipeline.zcount).toHaveBeenCalledWith(
      "bull:real:delayed",
      "-inf",
      expect.any(Number),
    )
    expect(pipeline.llen).toHaveBeenCalledTimes(2)
    expect(pipeline.zcount).toHaveBeenCalledTimes(1)
    expect(pipeline.llen).not.toHaveBeenCalledWith("bull:done-only:wait")
    expect(pipeline.llen).not.toHaveBeenCalledWith("bull:fail-only:wait")
    expect(pipeline.llen).not.toHaveBeenCalledWith("bull:repeat-only:wait")
    expect(pipeline.llen).not.toHaveBeenCalledWith("bull:meta-only:wait")
  })

  test("jobQueueSize pipelines wait then paused then delayed per queue in order", async () => {
    const frozenNow = 1_700_000_000_000
    const expectedDelayedUpper = (frozenNow + 1) * 0x1000 - 1
    jest.spyOn(Date, "now").mockReturnValue(frozenNow)
    exec.mockResolvedValue(
      emptyQueueResults(2).map((row, i) =>
        i % 3 === 0
          ? [null, Math.floor(i / 3) * 3 + 1]
          : i % 3 === 1
            ? [null, Math.floor(i / 3) * 3 + 2]
            : [null, Math.floor(i / 3) * 3 + 3],
      ),
    )

    try {
      await expect(
        jobQueueSize("default", "mailer", {
          connection: "redis://localhost:6379/0",
        }),
      ).resolves.toBe(21)

      expect(pipeline.llen.mock.calls.map((c) => c[0])).toEqual([
        "bull:default:wait",
        "bull:default:paused",
        "bull:mailer:wait",
        "bull:mailer:paused",
      ])
      expect(pipeline.zcount.mock.calls).toEqual([
        ["bull:default:delayed", "-inf", expectedDelayedUpper],
        ["bull:mailer:delayed", "-inf", expectedDelayedUpper],
      ])
      const sequence = []
      for (const [name, calls] of [
        ["llen", pipeline.llen.mock.invocationCallOrder],
        ["zcount", pipeline.zcount.mock.invocationCallOrder],
      ]) {
        calls.forEach((order, idx) => sequence.push({ name, order, idx }))
      }
      sequence.sort((a, b) => a.order - b.order)
      expect(sequence.map((s) => s.name)).toEqual([
        "llen",
        "llen",
        "zcount",
        "llen",
        "llen",
        "zcount",
      ])
    } finally {
      Date.now.mockRestore()
    }
  })

  test("jobQueueSize coerces string pipeline counts to numbers", async () => {
    exec.mockResolvedValueOnce([
      [null, "2"],
      [null, "3"],
      [null, "4"],
    ])
    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(9)
  })

  test("jobQueueSize defaults to localhost Redis when env ladder is empty", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    const keys = [
      "REDIS_TLS_URL",
      "REDIS_URL",
      "REDISTOGO_URL",
      "REDISCLOUD_URL",
      "OPENREDIS_URL",
      "HIREFIRE_BULL_URL",
    ]
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      for (const k of keys) delete process.env[k]
      await jobQueueSize("default")
      expect(IORedis).toHaveBeenCalledWith(
        "redis://localhost:6379/0",
        expect.objectContaining({
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          commandTimeout: 5000,
        }),
      )
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  test("jobQueueSize env ladder prefers REDIS_TLS_URL over REDIS_URL", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    const keys = [
      "REDIS_TLS_URL",
      "REDIS_URL",
      "REDISTOGO_URL",
      "REDISCLOUD_URL",
      "OPENREDIS_URL",
      "HIREFIRE_BULL_URL",
    ]
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      for (const k of keys) delete process.env[k]
      process.env.REDIS_TLS_URL = "redis://tls-first:6379/0"
      process.env.REDIS_URL = "redis://url-second:6379/0"
      process.env.HIREFIRE_BULL_URL = "redis://hirefire-ignored:6379/0"
      await jobQueueSize("default")
      expect(IORedis).toHaveBeenCalledWith(
        "redis://tls-first:6379/0",
        expect.any(Object),
      )
      expect(IORedis).not.toHaveBeenCalledWith(
        "redis://url-second:6379/0",
        expect.any(Object),
      )
      expect(IORedis).not.toHaveBeenCalledWith(
        "redis://hirefire-ignored:6379/0",
        expect.any(Object),
      )
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  test("jobQueueSize env ladder walks REDIS_URL → REDISTOGO → REDISCLOUD → OPENREDIS", async () => {
    exec.mockResolvedValue(emptyQueueResults(1))
    const keys = [
      "REDIS_TLS_URL",
      "REDIS_URL",
      "REDISTOGO_URL",
      "REDISCLOUD_URL",
      "OPENREDIS_URL",
      "HIREFIRE_BULL_URL",
    ]
    const ladder = [
      ["REDIS_URL", "redis://from-redis-url:6379/0"],
      ["REDISTOGO_URL", "redis://from-redistogo:6379/0"],
      ["REDISCLOUD_URL", "redis://from-rediscloud:6379/0"],
      ["OPENREDIS_URL", "redis://from-openredis:6379/0"],
    ]
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      for (const k of keys) delete process.env[k]
      process.env.HIREFIRE_BULL_URL = "redis://hirefire-ignored:6379/0"
      for (const [k, url] of ladder) process.env[k] = url

      for (let i = 0; i < ladder.length; i++) {
        IORedis.mockClear()
        await jobQueueSize("default")
        expect(IORedis).toHaveBeenCalledWith(ladder[i][1], expect.any(Object))
        for (let j = 0; j < ladder.length; j++) {
          if (j === i) continue
          expect(IORedis).not.toHaveBeenCalledWith(
            ladder[j][1],
            expect.any(Object),
          )
        }
        expect(IORedis).not.toHaveBeenCalledWith(
          "redis://hirefire-ignored:6379/0",
          expect.any(Object),
        )
        delete process.env[ladder[i][0]]
      }
    } finally {
      for (const k of keys) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
    }
  })

  test("jobQueueSize disconnects when quit rejects after success", async () => {
    const disconnect = jest.fn()
    quit.mockRejectedValueOnce(new Error("quit failed"))
    exec.mockResolvedValueOnce([
      [null, 1],
      [null, 0],
      [null, 0],
    ])
    ;({ IORedis, jobQueueSize } = loadBullWithMockedIORedis(() => ({
      pipeline: () => pipeline,
      quit,
      disconnect,
      on: jest.fn(),
    })))

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(1)
    expect(quit).toHaveBeenCalledTimes(1)
    expect(disconnect).toHaveBeenCalledTimes(1)
  })

  test("jobQueueSize never issues priority ZCARD or wait LINDEX", async () => {
    const zcard = jest.fn().mockReturnThis()
    const lindex = jest.fn().mockReturnThis()
    pipeline.zcard = zcard
    pipeline.lindex = lindex
    exec.mockResolvedValueOnce([
      [null, 1],
      [null, 0],
      [null, 0],
    ])

    await expect(
      jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
    ).resolves.toBe(1)
    expect(zcard).not.toHaveBeenCalled()
    expect(lindex).not.toHaveBeenCalled()
    expect(pipeline.llen).toHaveBeenCalledWith("bull:default:wait")
    expect(pipeline.llen).toHaveBeenCalledWith("bull:default:paused")
    expect(pipeline.zcount).toHaveBeenCalledWith(
      "bull:default:delayed",
      "-inf",
      expect.any(Number),
    )
  })
})
