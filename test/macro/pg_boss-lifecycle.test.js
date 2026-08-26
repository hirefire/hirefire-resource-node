let pg
try {
  pg = require("pg")
} catch {
  pg = null
}

const {
  jobQueueSize,
  jobQueueLatency,
  jobQueueWorking,
  _resetBlockedColumnCacheForTests,
} = require("../../src/macro/pg_boss")

const describeIfPg = pg ? describe : describe.skip

describeIfPg("pg-boss connection lifecycle", () => {
  let end
  let query
  let on
  let poolSpy

  beforeEach(() => {
    _resetBlockedColumnCacheForTests()
    end = jest.fn().mockResolvedValue(undefined)
    query = jest.fn()
    on = jest.fn()
    poolSpy = jest.spyOn(pg, "Pool").mockImplementation(() => ({
      query,
      end,
      on,
    }))
  })

  afterEach(() => {
    _resetBlockedColumnCacheForTests()
    poolSpy.mockRestore()
    jest.clearAllMocks()
  })

  function mockEmptySize() {
    query
      .mockResolvedValueOnce({ rows: [] }) // blocked column probe
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
  }

  function mockEmptyLatency() {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
  }

  function expectWaitingSql(sql) {
    expect(sql).toMatch(/state\s*<\s*'active'/)
    expect(sql).toMatch(/start_after\s*<=\s*now\(\)/)
    expect(sql).not.toMatch(/\bfetch\b/i)
    expect(sql).not.toMatch(/getQueueSize/i)
    expect(sql).not.toMatch(/ready_count/i)
    expect(sql).not.toMatch(/FOR UPDATE/i)
    expect(sql).not.toMatch(/\bSKIP LOCKED\b/i)
  }

  test("ends owned pool after a successful sample", async () => {
    mockEmptySize()
    await expect(
      jobQueueSize({ connection: "postgres://localhost/jobs" }),
    ).resolves.toBe(0)
    expect(end).toHaveBeenCalledTimes(1)
    expect(on).toHaveBeenCalledWith("error", expect.any(Function))
    expect(poolSpy).toHaveBeenCalledTimes(1)
    expect(poolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        max: 1,
        connectionTimeoutMillis: 5000,
        idleTimeoutMillis: 1000,
        query_timeout: 5000,
        statement_timeout: 5000,
        connectionString: "postgres://localhost/jobs",
      }),
    )
  })

  test("ends owned pool after a query error", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("query failed"))
    await expect(
      jobQueueSize({ connection: "postgres://localhost/jobs" }),
    ).rejects.toThrow("query failed")
    expect(end).toHaveBeenCalledTimes(1)
  })

  test("ends owned pool when blocked column probe fails", async () => {
    query.mockRejectedValueOnce(new Error("probe failed"))
    await expect(
      jobQueueSize({ connection: "postgres://localhost/jobs" }),
    ).rejects.toThrow("probe failed")
    expect(end).toHaveBeenCalledTimes(1)
  })

  test("successful sample still returns when pool.end rejects", async () => {
    mockEmptySize()
    end.mockRejectedValueOnce(new Error("end failed"))
    await expect(
      jobQueueSize({ connection: "postgres://localhost/jobs" }),
    ).resolves.toBe(0)
    expect(end).toHaveBeenCalledTimes(1)
  })

  test("query error still surfaces when pool.end also rejects", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error("query failed"))
    end.mockRejectedValueOnce(new Error("end failed"))
    await expect(
      jobQueueSize({ connection: "postgres://localhost/jobs" }),
    ).rejects.toThrow("query failed")
    expect(end).toHaveBeenCalledTimes(1)
  })

  test("pins connectionString after connectionOptions spread", async () => {
    mockEmptySize()
    await jobQueueSize({
      connection: "postgres://resolved/jobs",
      connectionOptions: {
        connectionString: "postgres://attacker/other",
        max: 3,
      },
    })
    expect(poolSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgres://resolved/jobs",
        max: 3,
        query_timeout: 5000,
        statement_timeout: 5000,
      }),
    )
  })

  test("rejects non-queryable object connection", async () => {
    await expect(
      jobQueueSize({ connection: { host: "localhost" } }),
    ).rejects.toThrow(/URL string or a client\/Pool with \.query/)
    expect(poolSpy).not.toHaveBeenCalled()
  })

  test("does not end a borrowed pool", async () => {
    const borrowed = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ job_queue_size: "2" }] }),
      end: jest.fn(),
    }
    await expect(
      jobQueueSize({ connection: borrowed, schema: "pgboss" }),
    ).resolves.toBe(2)
    expect(borrowed.end).not.toHaveBeenCalled()
    expect(poolSpy).not.toHaveBeenCalled()
  })

  test("options.pool is borrowed and not ended", async () => {
    const pool = {
      query: jest
        .fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ job_queue_size: "3" }] }),
      end: jest.fn(),
    }
    await expect(jobQueueSize({ pool, schema: "pgboss" })).resolves.toBe(3)
    expect(pool.end).not.toHaveBeenCalled()
    expect(poolSpy).not.toHaveBeenCalled()
  })

  test("schema is lowercased for SQL and catalog probe", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] }) // blocked present
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
    await jobQueueSize({
      connection: "postgres://localhost/jobs",
      schema: "PgBoss",
    })
    expect(query.mock.calls[0][0]).toMatch(/information_schema/)
    expect(query.mock.calls[0][1]).toEqual(["pgboss"])
    expect(query.mock.calls[1][0]).toMatch(/FROM pgboss\.job/)
    expect(query.mock.calls[1][0]).toMatch(/NOT blocked/)
    expectWaitingSql(query.mock.calls[1][0])
  })

  test("size SQL is count of waiting rows with optional queue filter", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "4" }] })
    await expect(
      jobQueueSize("email", "sms", {
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
      }),
    ).resolves.toBe(4)
    const sizeSql = query.mock.calls[1][0]
    expect(sizeSql).toMatch(/SELECT COUNT\(\*\)::bigint AS job_queue_size/)
    expect(sizeSql).toMatch(/name = ANY\(\$1::text\[\]\)/)
    expectWaitingSql(sizeSql)
    expect(query.mock.calls[1][1]).toEqual([["email", "sms"]])
  })

  test("working SQL counts active rows with optional queue filter", async () => {
    query.mockResolvedValueOnce({ rows: [{ job_queue_working: "2" }] })
    await expect(
      jobQueueWorking("email", {
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
      }),
    ).resolves.toBe(2)
    expect(query).toHaveBeenCalledTimes(1)
    const workingSql = query.mock.calls[0][0]
    expect(workingSql).toMatch(
      /SELECT COUNT\(\*\)::bigint AS job_queue_working/,
    )
    expect(workingSql).toMatch(/state = 'active'/)
    expect(workingSql).toMatch(/name = ANY\(\$1::text\[\]\)/)
    expect(workingSql).not.toMatch(/information_schema/)
    expect(workingSql).not.toMatch(/FOR UPDATE/i)
    expect(query.mock.calls[0][1]).toEqual([["email"]])
  })

  test("all-queues size omits name filter", async () => {
    mockEmptySize()
    await jobQueueSize({ connection: "postgres://localhost/jobs" })
    const sizeSql = query.mock.calls[1][0]
    expect(sizeSql).not.toMatch(/name = ANY/)
    expectWaitingSql(sizeSql)
    expect(query.mock.calls[1][1]).toEqual([])
  })

  test("latency SQL orders by start_after and returns 0 on empty", async () => {
    mockEmptyLatency()
    await expect(
      jobQueueLatency({ connection: "postgres://localhost/jobs" }),
    ).resolves.toBe(0)
    expect(end).toHaveBeenCalledTimes(1)
    const latencySql = query.mock.calls[1][0]
    expect(latencySql).toMatch(
      /EXTRACT\(EPOCH FROM \(now\(\) - start_after\)\)/,
    )
    expect(latencySql).toMatch(/ORDER BY start_after ASC/)
    expect(latencySql).toMatch(/LIMIT 1/)
    expect(latencySql).not.toMatch(/created_on/)
    expect(latencySql).not.toMatch(/name = ANY/)
    expectWaitingSql(latencySql)
    expect(query.mock.calls[1][1]).toEqual([])
  })

  test("latency SQL filters named queues and binds name list", async () => {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ latency: 9 }] })
    await expect(
      jobQueueLatency("email", "sms", {
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
      }),
    ).resolves.toBe(9)
    const latencySql = query.mock.calls[1][0]
    expect(latencySql).toMatch(
      /EXTRACT\(EPOCH FROM \(now\(\) - start_after\)\)/,
    )
    expect(latencySql).toMatch(/name = ANY\(\$1::text\[\]\)/)
    expect(latencySql).toMatch(/ORDER BY start_after ASC/)
    expect(latencySql).not.toMatch(/created_on/)
    expectWaitingSql(latencySql)
    expect(query.mock.calls[1][1]).toEqual([["email", "sms"]])
  })

  test("latency SQL includes NOT blocked when column present", async () => {
    query
      .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] })
      .mockResolvedValueOnce({ rows: [{ latency: 12.5 }] })
    await expect(
      jobQueueLatency("email", {
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
      }),
    ).resolves.toBe(12.5)
    expect(query.mock.calls[1][0]).toMatch(/NOT blocked/)
    expect(query.mock.calls[1][0]).toMatch(/name = ANY\(\$1::text\[\]\)/)
    expect(query.mock.calls[1][1]).toEqual([["email"]])
    expectWaitingSql(query.mock.calls[1][0])
  })

  test("absence of blocked is cached briefly; presence is cached", async () => {
    jest.useFakeTimers()
    try {
      const url = "postgres://localhost/cache-probe"
      query
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
      await jobQueueSize({ connection: url, schema: "pgboss" })
      expect(query.mock.calls[0][0]).toMatch(/information_schema/)
      expect(query.mock.calls[1][0]).not.toMatch(/NOT blocked/)

      query.mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
      await jobQueueSize({ connection: url, schema: "pgboss" })
      expect(query).toHaveBeenCalledTimes(3)
      expect(query.mock.calls[2][0]).not.toMatch(/information_schema/)
      expect(query.mock.calls[2][0]).not.toMatch(/NOT blocked/)

      jest.advanceTimersByTime(60_000)

      query
        .mockResolvedValueOnce({ rows: [{ "?column?": 1 }] })
        .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
      await jobQueueSize({ connection: url, schema: "pgboss" })
      expect(query.mock.calls[3][0]).toMatch(/information_schema/)
      expect(query.mock.calls[4][0]).toMatch(/NOT blocked/)

      query.mockResolvedValueOnce({ rows: [{ job_queue_size: "1" }] })
      await expect(
        jobQueueSize({ connection: url, schema: "pgboss" }),
      ).resolves.toBe(1)
      expect(query).toHaveBeenCalledTimes(6)
      expect(query.mock.calls[5][0]).toMatch(/NOT blocked/)
      expect(query.mock.calls[5][0]).not.toMatch(/information_schema/)
    } finally {
      jest.useRealTimers()
    }
  })

  test("HIREFIRE_PG_BOSS_URL wins over DATABASE_URL when both set", async () => {
    const prevHirefire = process.env.HIREFIRE_PG_BOSS_URL
    const prevDb = process.env.DATABASE_URL
    process.env.HIREFIRE_PG_BOSS_URL = "postgres://hirefire-override/jobs"
    process.env.DATABASE_URL = "postgres://database-url-fallback/jobs"
    try {
      mockEmptySize()
      await expect(jobQueueSize()).resolves.toBe(0)
      expect(poolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgres://hirefire-override/jobs",
        }),
      )
    } finally {
      if (prevHirefire === undefined) delete process.env.HIREFIRE_PG_BOSS_URL
      else process.env.HIREFIRE_PG_BOSS_URL = prevHirefire
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
    }
  })

  test("blank HIREFIRE_PG_BOSS_URL is ignored; DATABASE_URL is used", async () => {
    const prevHirefire = process.env.HIREFIRE_PG_BOSS_URL
    const prevDb = process.env.DATABASE_URL
    process.env.HIREFIRE_PG_BOSS_URL = "   "
    process.env.DATABASE_URL = "postgres://from-database-url/jobs"
    try {
      mockEmptySize()
      await expect(jobQueueSize()).resolves.toBe(0)
      expect(poolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgres://from-database-url/jobs",
        }),
      )
    } finally {
      if (prevHirefire === undefined) delete process.env.HIREFIRE_PG_BOSS_URL
      else process.env.HIREFIRE_PG_BOSS_URL = prevHirefire
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
    }
  })

  test("samples via DATABASE_URL when HIREFIRE_PG_BOSS_URL is unset", async () => {
    const prevHirefire = process.env.HIREFIRE_PG_BOSS_URL
    const prevDb = process.env.DATABASE_URL
    delete process.env.HIREFIRE_PG_BOSS_URL
    process.env.DATABASE_URL = "postgres://from-database-url/jobs"
    try {
      mockEmptySize()
      await expect(jobQueueSize()).resolves.toBe(0)
      expect(poolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgres://from-database-url/jobs",
        }),
      )
    } finally {
      if (prevHirefire === undefined) delete process.env.HIREFIRE_PG_BOSS_URL
      else process.env.HIREFIRE_PG_BOSS_URL = prevHirefire
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
    }
  })

  test("default localhost URL when HIREFIRE_PG_BOSS_URL and DATABASE_URL are unset", async () => {
    const prevHirefire = process.env.HIREFIRE_PG_BOSS_URL
    const prevDb = process.env.DATABASE_URL
    delete process.env.HIREFIRE_PG_BOSS_URL
    delete process.env.DATABASE_URL
    try {
      mockEmptySize()
      await expect(jobQueueSize()).resolves.toBe(0)
      expect(poolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgres://127.0.0.1:5432/postgres",
        }),
      )
    } finally {
      if (prevHirefire === undefined) delete process.env.HIREFIRE_PG_BOSS_URL
      else process.env.HIREFIRE_PG_BOSS_URL = prevHirefire
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
    }
  })

  test("blank options.connection falls through to env ladder", async () => {
    const prevHirefire = process.env.HIREFIRE_PG_BOSS_URL
    const prevDb = process.env.DATABASE_URL
    process.env.HIREFIRE_PG_BOSS_URL = "postgres://from-env-after-blank/jobs"
    delete process.env.DATABASE_URL
    try {
      mockEmptySize()
      await expect(jobQueueSize({ connection: "" })).resolves.toBe(0)
      expect(poolSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          connectionString: "postgres://from-env-after-blank/jobs",
        }),
      )
    } finally {
      if (prevHirefire === undefined) delete process.env.HIREFIRE_PG_BOSS_URL
      else process.env.HIREFIRE_PG_BOSS_URL = prevHirefire
      if (prevDb === undefined) delete process.env.DATABASE_URL
      else process.env.DATABASE_URL = prevDb
    }
  })

  test("schema env is lowercased when options.schema is omitted", async () => {
    const prevSchema = process.env.HIREFIRE_PG_BOSS_SCHEMA
    process.env.HIREFIRE_PG_BOSS_SCHEMA = "Custom_Schema"
    try {
      mockEmptySize()
      await jobQueueSize({ connection: "postgres://localhost/jobs" })
      expect(query.mock.calls[0][1]).toEqual(["custom_schema"])
      expect(query.mock.calls[1][0]).toMatch(/FROM custom_schema\.job/)
    } finally {
      if (prevSchema === undefined) delete process.env.HIREFIRE_PG_BOSS_SCHEMA
      else process.env.HIREFIRE_PG_BOSS_SCHEMA = prevSchema
    }
  })

  test("options.schema wins over HIREFIRE_PG_BOSS_SCHEMA", async () => {
    const prevSchema = process.env.HIREFIRE_PG_BOSS_SCHEMA
    process.env.HIREFIRE_PG_BOSS_SCHEMA = "from_env"
    try {
      mockEmptySize()
      await jobQueueSize({
        connection: "postgres://localhost/jobs",
        schema: "from_options",
      })
      expect(query.mock.calls[0][1]).toEqual(["from_options"])
      expect(query.mock.calls[1][0]).toMatch(/FROM from_options\.job/)
    } finally {
      if (prevSchema === undefined) delete process.env.HIREFIRE_PG_BOSS_SCHEMA
      else process.env.HIREFIRE_PG_BOSS_SCHEMA = prevSchema
    }
  })

  test("default schema is pgboss when unset", async () => {
    const prevSchema = process.env.HIREFIRE_PG_BOSS_SCHEMA
    delete process.env.HIREFIRE_PG_BOSS_SCHEMA
    try {
      mockEmptySize()
      await jobQueueSize({ connection: "postgres://localhost/jobs" })
      expect(query.mock.calls[0][1]).toEqual(["pgboss"])
      expect(query.mock.calls[1][0]).toMatch(/FROM pgboss\.job/)
    } finally {
      if (prevSchema === undefined) delete process.env.HIREFIRE_PG_BOSS_SCHEMA
      else process.env.HIREFIRE_PG_BOSS_SCHEMA = prevSchema
    }
  })
})
