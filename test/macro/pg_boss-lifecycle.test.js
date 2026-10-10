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
} = require("../../src/macro/pg_boss")

const COLUMNS = ["blocked", "expire_in", "expire_seconds", "heartbeat_seconds"]
const REAL_TIMERS = [
  "nextTick",
  "setImmediate",
  "clearImmediate",
  "setInterval",
  "clearInterval",
  "setTimeout",
  "clearTimeout",
  "queueMicrotask",
  "hrtime",
  "performance",
]

const describeIfPg = pg ? describe : describe.skip

describeIfPg("pg-boss connection lifecycle", () => {
  let end
  let query
  let on
  let poolSpy
  let clock = Date.now()

  function columns(...names) {
    return { rows: names.map((name) => ({ column_name: name })) }
  }

  beforeEach(() => {
    clock += 120_000
    jest.useFakeTimers({ now: clock, doNotFake: REAL_TIMERS })
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
    jest.useRealTimers()
    poolSpy.mockRestore()
    jest.clearAllMocks()
  })

  function mockEmptySize() {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
  }

  function mockEmptyLatency() {
    query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
  }

  function whereClause(sql) {
    return sql
      .replace(/\s+/g, " ")
      .split(" WHERE ")[1]
      .split(" ORDER BY ")[0]
      .trim()
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
    expect(poolSpy.mock.calls).toEqual([
      [
        {
          max: 1,
          connectionTimeoutMillis: 5000,
          idleTimeoutMillis: 1000,
          query_timeout: 5000,
          connectionString: "postgres://localhost/jobs",
        },
      ],
    ])
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

  test("ends owned pool when the read of the job columns fails", async () => {
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
      .mockResolvedValueOnce(columns("blocked"))
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] })
    await jobQueueSize({
      connection: "postgres://localhost/jobs",
      schema: "PgBoss",
    })
    expect(query.mock.calls[0][0]).toMatch(/information_schema/)
    expect(query.mock.calls[0][1]).toEqual(["pgboss", COLUMNS])
    expect(query.mock.calls[1][0]).toMatch(/FROM pgboss\.job/)
    expect(query.mock.calls[1][0]).toMatch(/NOT blocked/)
    expectWaitingSql(query.mock.calls[1][0])
  })

  test("size SQL counts waiting and active rows inside the queue filter", async () => {
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
    expect(whereClause(sizeSql)).toBe(
      "((state < 'active' AND start_after <= now()) OR state = 'active') " +
        "AND name = ANY($1::text[])",
    )
    expectWaitingSql(sizeSql)
    expect(query.mock.calls[1][1]).toEqual([["email", "sms"]])
  })

  test("size SQL keeps NOT blocked on the waiting side only", async () => {
    query
      .mockResolvedValueOnce(columns("blocked"))
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "4" }] })
    await jobQueueSize("email", {
      connection: "postgres://localhost/jobs",
      schema: "pgboss",
    })
    expect(whereClause(query.mock.calls[1][0])).toBe(
      "((state < 'active' AND start_after <= now() AND NOT blocked) " +
        "OR state = 'active') AND name = ANY($1::text[])",
    )
  })

  test("size SQL with skipWorking counts waiting rows only", async () => {
    query
      .mockResolvedValueOnce(columns("blocked"))
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "3" }] })
      .mockResolvedValueOnce({ rows: [{ job_queue_size: "5" }] })
    await expect(
      jobQueueSize("email", {
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
        skipWorking: true,
      }),
    ).resolves.toBe(3)
    const sizeSql = query.mock.calls[1][0]
    expect(sizeSql).not.toMatch(/state = 'active'/)
    expect(whereClause(sizeSql)).toBe(
      "(state < 'active' AND start_after <= now() AND NOT blocked) " +
        "AND name = ANY($1::text[])",
    )
    expectWaitingSql(sizeSql)
    expect(query.mock.calls[1][1]).toEqual([["email"]])

    await expect(
      jobQueueSize({
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
        skipWorking: true,
      }),
    ).resolves.toBe(5)
    expect(whereClause(query.mock.calls[2][0])).toBe(
      "state < 'active' AND start_after <= now() AND NOT blocked",
    )
    expect(query.mock.calls[2][1]).toEqual([])
  })

  test("working SQL counts active rows with optional queue filter", async () => {
    query
      .mockResolvedValueOnce(columns("blocked"))
      .mockResolvedValueOnce({ rows: [{ job_queue_working: "2" }] })
    await expect(
      jobQueueWorking("email", {
        connection: "postgres://localhost/jobs",
        schema: "pgboss",
      }),
    ).resolves.toBe(2)
    expect(query).toHaveBeenCalledTimes(2)
    const workingSql = query.mock.calls[1][0]
    expect(workingSql).toMatch(
      /SELECT COUNT\(\*\)::bigint AS job_queue_working/,
    )
    expect(whereClause(workingSql)).toBe(
      "(state = 'active') AND name = ANY($1::text[])",
    )
    expect(workingSql).not.toMatch(/FOR UPDATE/i)
    expect(query.mock.calls[1][1]).toEqual([["email"]])
  })

  describe.each([
    [
      "expire_seconds",
      ["expire_seconds"],
      "started_on + expire_seconds * interval '1 second' < now()",
    ],
    ["expire_in", ["expire_in"], "started_on + expire_in < now()"],
    [
      "expire_seconds and heartbeat_seconds",
      ["expire_seconds", "heartbeat_seconds"],
      "started_on + expire_seconds * interval '1 second' < now() OR " +
        "heartbeat_on + heartbeat_seconds * interval '1 second' < now()",
    ],
  ])("a job table with %s", (_label, names, dead) => {
    const waiting = "state < 'active' AND start_after <= now()"
    const options = { connection: "postgres://localhost/jobs" }

    beforeEach(() => {
      query.mockResolvedValueOnce(columns(...names))
    })

    test("counts an active row past its limit as waiting in a size without running jobs", async () => {
      query.mockResolvedValueOnce({ rows: [{ job_queue_size: "2" }] })

      await jobQueueSize({ ...options, skipWorking: true })

      expect(whereClause(query.mock.calls[1][0])).toBe(
        `(${waiting}) OR (state = 'active' AND (${dead}))`,
      )
    })

    test("counts every active row once in a size with running jobs", async () => {
      query.mockResolvedValueOnce({ rows: [{ job_queue_size: "2" }] })

      await jobQueueSize("email", options)

      expect(whereClause(query.mock.calls[1][0])).toBe(
        `((${waiting}) OR state = 'active') AND name = ANY($1::text[])`,
      )
    })

    test("leaves an active row past its limit out of the running count", async () => {
      query.mockResolvedValueOnce({ rows: [{ job_queue_working: "1" }] })

      await jobQueueWorking("email", options)

      expect(whereClause(query.mock.calls[1][0])).toBe(
        `(state = 'active' AND (${dead}) IS NOT TRUE) AND name = ANY($1::text[])`,
      )
    })

    test("measures the latency of an active row past its limit", async () => {
      query.mockResolvedValueOnce({ rows: [{ latency: 3 }] })

      await jobQueueLatency(options)

      expect(whereClause(query.mock.calls[1][0])).toBe(
        `(${waiting}) OR (state = 'active' AND (${dead}))`,
      )
    })
  })

  test("all-queues size omits name filter", async () => {
    mockEmptySize()
    await jobQueueSize({ connection: "postgres://localhost/jobs" })
    const sizeSql = query.mock.calls[1][0]
    expect(sizeSql).not.toMatch(/name = ANY/)
    expect(whereClause(sizeSql)).toBe(
      "(state < 'active' AND start_after <= now()) OR state = 'active'",
    )
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
    expect(whereClause(latencySql)).toBe(
      "state < 'active' AND start_after <= now()",
    )
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
    expect(whereClause(latencySql)).toBe(
      "(state < 'active' AND start_after <= now()) AND name = ANY($1::text[])",
    )
    expectWaitingSql(latencySql)
    expect(query.mock.calls[1][1]).toEqual([["email", "sms"]])
  })

  test("latency SQL includes NOT blocked when column present", async () => {
    query
      .mockResolvedValueOnce(columns("blocked"))
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

  test("the columns of the job table are read once a minute per schema and connection", async () => {
    const url = "postgres://localhost/cache-probe"
    const size = { rows: [{ job_queue_size: "0" }] }
    const reads = () =>
      query.mock.calls.filter(([sql]) => /information_schema/.test(sql)).length
    query.mockResolvedValue(size)

    query.mockResolvedValueOnce(columns())
    await jobQueueSize({ connection: url, schema: "pgboss" })
    await jobQueueSize({ connection: url, schema: "pgboss" })
    await jobQueueWorking({ connection: url, schema: "pgboss" })
    expect(reads()).toBe(1)
    expect(query.mock.calls[2][0]).not.toMatch(/NOT blocked/)

    jest.setSystemTime(clock + 59_999)
    await jobQueueSize({ connection: url, schema: "pgboss" })
    expect(reads()).toBe(1)

    jest.setSystemTime(clock + 60_000)
    query.mockResolvedValueOnce(columns("blocked"))
    await jobQueueSize({ connection: url, schema: "pgboss" })
    expect(reads()).toBe(2)
    expect(query.mock.calls.at(-1)[0]).toMatch(/NOT blocked/)

    await jobQueueSize({ connection: url, schema: "pgboss" })
    expect(reads()).toBe(2)
    expect(query.mock.calls.at(-1)[0]).toMatch(/NOT blocked/)

    query.mockResolvedValueOnce(columns())
    await jobQueueSize({ connection: url, schema: "other" })
    expect(reads()).toBe(3)
    expect(query.mock.calls.at(-1)[0]).not.toMatch(/NOT blocked/)

    query.mockResolvedValueOnce(columns())
    await jobQueueSize({ connection: `${url}-2`, schema: "pgboss" })
    expect(reads()).toBe(4)
    expect(query.mock.calls.at(-1)[0]).not.toMatch(/NOT blocked/)
  })

  test("a borrowed pool is told apart by its connection string, by its host, port, and database, or by itself", async () => {
    const size = { rows: [{ job_queue_size: "0" }] }
    function pool(fields) {
      const answer = async (sql) =>
        /information_schema/.test(sql) ? columns() : size
      return { ...fields, query: jest.fn(answer) }
    }
    async function reads(borrowed) {
      await jobQueueSize({ connection: borrowed })
      return borrowed.query.mock.calls.filter(([sql]) =>
        /information_schema/.test(sql),
      ).length
    }

    expect(await reads(pool({ options: { connectionString: "a" } }))).toBe(1)
    expect(await reads(pool({ options: { connectionString: "a" } }))).toBe(0)
    expect(await reads(pool({ options: { connectionString: "b" } }))).toBe(1)

    expect(await reads(pool({ host: "h", port: 1, database: "d" }))).toBe(1)
    expect(await reads(pool({ host: "h", port: 1, database: "d" }))).toBe(0)
    expect(await reads(pool({ host: "h", port: 2, database: "d" }))).toBe(1)
    expect(await reads(pool({ host: "h", port: 1, database: "e" }))).toBe(1)
    expect(await reads(pool({ host: "i", port: 1, database: "d" }))).toBe(1)
    expect(await reads(pool({ host: "j" }))).toBe(1)
    expect(await reads(pool({ host: "j", port: 5432, database: "" }))).toBe(0)

    const first = pool({})
    const second = pool({})
    expect(await reads(first)).toBe(1)
    expect(await reads(first)).toBe(1)
    expect(await reads(second)).toBe(1)
    expect(await reads(second)).toBe(1)
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
          connectionString:
            "postgres://postgres:postgres@127.0.0.1:5432/postgres",
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
      expect(query.mock.calls[0][1]).toEqual(["custom_schema", COLUMNS])
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
      expect(query.mock.calls[0][1]).toEqual(["from_options", COLUMNS])
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
      expect(query.mock.calls[0][1]).toEqual(["pgboss", COLUMNS])
      expect(query.mock.calls[1][0]).toMatch(/FROM pgboss\.job/)
    } finally {
      if (prevSchema === undefined) delete process.env.HIREFIRE_PG_BOSS_SCHEMA
      else process.env.HIREFIRE_PG_BOSS_SCHEMA = prevSchema
    }
  })

  describe("SSL on Heroku", () => {
    const keys = ["DYNO", "PGSSLMODE", "DATABASE_URL", "HIREFIRE_PG_BOSS_URL"]
    let saved

    beforeEach(() => {
      saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]))
      for (const key of keys) delete process.env[key]
    })

    afterEach(() => {
      for (const key of keys) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    })

    async function poolOptions(...args) {
      mockEmptySize()
      await jobQueueSize(...args)
      return poolSpy.mock.calls[0][0]
    }

    test("a dyno connects over SSL without certificate verification", async () => {
      process.env.DYNO = "worker.1"
      const options = await poolOptions({ connection: "postgres://host/jobs" })
      expect(options.ssl).toEqual({ rejectUnauthorized: false })
    })

    test("a dyno connects over SSL to a URL from the environment", async () => {
      process.env.DYNO = "worker.1"
      process.env.DATABASE_URL = "postgres://database-url/jobs"
      const options = await poolOptions()
      expect(options.connectionString).toBe("postgres://database-url/jobs")
      expect(options.ssl).toEqual({ rejectUnauthorized: false })
    })

    test("no SSL option is set off Heroku", async () => {
      const options = await poolOptions({ connection: "postgres://host/jobs" })
      expect(options).not.toHaveProperty("ssl")
    })

    test("a blank DYNO sets no SSL option", async () => {
      process.env.DYNO = ""
      const options = await poolOptions({ connection: "postgres://host/jobs" })
      expect(options).not.toHaveProperty("ssl")
    })

    test.each([[false], [true], [{ ca: "certificate" }]])(
      "connectionOptions.ssl %j wins on a dyno",
      async (ssl) => {
        process.env.DYNO = "worker.1"
        const options = await poolOptions({
          connection: "postgres://host/jobs",
          connectionOptions: { ssl },
        })
        expect(options.ssl).toEqual(ssl)
      },
    )

    test("PGSSLMODE leaves the SSL setting to pg on a dyno", async () => {
      process.env.DYNO = "worker.1"
      process.env.PGSSLMODE = "disable"
      const options = await poolOptions({ connection: "postgres://host/jobs" })
      expect(options).not.toHaveProperty("ssl")
    })

    test.each([
      ["postgres://host/jobs?sslmode=require"],
      ["postgres://host/jobs?application_name=app&sslmode=disable"],
      ["postgres://host/jobs?ssl=true"],
      ["postgres://host/jobs?sslrootcert=/etc/ca.pem"],
    ])(
      "an SSL parameter in %s leaves the setting to pg on a dyno",
      async (url) => {
        process.env.DYNO = "worker.1"
        const options = await poolOptions({ connection: url })
        expect(options).not.toHaveProperty("ssl")
      },
    )

    test("a borrowed pool is used as it is on a dyno", async () => {
      process.env.DYNO = "worker.1"
      const borrowed = {
        query: jest
          .fn()
          .mockResolvedValueOnce({ rows: [] })
          .mockResolvedValueOnce({ rows: [{ job_queue_size: "0" }] }),
      }
      await expect(jobQueueSize({ pool: borrowed })).resolves.toBe(0)
      expect(poolSpy).not.toHaveBeenCalled()
    })
  })
})
