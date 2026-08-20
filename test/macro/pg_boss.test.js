const { execFileSync } = require("child_process")
const path = require("path")
const { Pool } = require("pg")
const {
  jobQueueLatency,
  jobQueueSize,
  jobQueueWorking,
  _resetBlockedColumnCacheForTests,
} = require("../../src/macro/pg_boss")
const Plan = require("../../src/plan")
const Configuration = require("../../src/configuration")

const SCHEMA = "hf_pg_boss_test"
const postgresURL =
  process.env.HIREFIRE_PG_BOSS_URL ||
  process.env.DATABASE_URL ||
  `postgres://postgres@127.0.0.1:${
    process.env.POSTGRES_PORT || "5432"
  }/postgres`

const sampleOpts = { connection: postgresURL, schema: SCHEMA }
const setupScript = path.join(__dirname, "pg_boss_setup.mjs")

async function hasBlockedColumn(pool) {
  const { rows } = await pool.query(
    `SELECT 1
       FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name = 'job'
        AND column_name = 'blocked'
      LIMIT 1`,
    [SCHEMA],
  )
  return rows.length > 0
}

function installedPgBossVersion() {
  try {
    return require("pg-boss/package.json").version
  } catch {
    return null
  }
}

/** True when the installed package is expected to ship schema with `blocked` (≥ 12.19). */
function expectsBlockedColumn(version) {
  if (!version) return false
  const [maj, min] = String(version)
    .split(".")
    .map((n) => parseInt(n, 10))
  if (!Number.isFinite(maj) || !Number.isFinite(min)) return false
  if (maj > 12) return true
  if (maj < 12) return false
  return min >= 19
}

async function insertJob(
  pool,
  { name, state = "created", startAfterSeconds = 0, blocked },
) {
  const cols = ["id", "name", "data", "state", "start_after"]
  const vals = [
    "gen_random_uuid()",
    "$1",
    "'{}'::jsonb",
    `$2::${SCHEMA}.job_state`,
    "now() + ($3::text || ' seconds')::interval",
  ]
  const params = [name, state, String(startAfterSeconds)]

  if (blocked !== undefined) {
    cols.push("blocked")
    vals.push("$4")
    params.push(blocked)
  }

  const { rows } = await pool.query(
    `INSERT INTO ${SCHEMA}.job (${cols.join(", ")})
     VALUES (${vals.join(", ")})
     RETURNING id::text AS id`,
    params,
  )
  return rows[0].id
}

async function setStartAfter(pool, id, relativeSeconds) {
  await pool.query(
    `UPDATE ${SCHEMA}.job
        SET start_after = now() + ($2::text || ' seconds')::interval
      WHERE id = $1`,
    [id, String(relativeSeconds)],
  )
}

async function setCreatedOn(pool, id, relativeSeconds) {
  await pool.query(
    `UPDATE ${SCHEMA}.job
        SET created_on = now() + ($2::text || ' seconds')::interval
      WHERE id = $1`,
    [id, String(relativeSeconds)],
  )
}

async function jobStates(pool) {
  const hasBlocked = await hasBlockedColumn(pool)
  const blockedSelect = hasBlocked ? "blocked" : "NULL::boolean AS blocked"
  const { rows } = await pool.query(
    `SELECT id::text AS id, name, state::text AS state,
            ${blockedSelect},
            EXTRACT(EPOCH FROM (now() - start_after))::float8 AS age_from_start_after,
            EXTRACT(EPOCH FROM (now() - created_on))::float8 AS age_from_created_on
       FROM ${SCHEMA}.job
      ORDER BY name, state, id`,
  )
  return rows
}

async function withEnv(overrides, fn) {
  const keys = Object.keys(overrides)
  const previous = {}
  for (const key of keys) {
    previous[key] = process.env[key]
    const value = overrides[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await fn()
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
  }
}

describe("pg-boss", () => {
  let pool

  beforeAll(async () => {
    pool = new Pool({ connectionString: postgresURL, max: 2 })
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
      execFileSync(
        process.execPath,
        [setupScript, postgresURL, SCHEMA, "email", "sms"],
        { stdio: "inherit", env: process.env },
      )
    } catch (error) {
      try {
        await pool.end()
      } catch {}
      pool = null
      throw error
    }
  }, 60_000)

  afterAll(async () => {
    if (!pool) return
    try {
      await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    } finally {
      try {
        await pool.end()
      } catch {}
    }
  })

  beforeEach(async () => {
    _resetBlockedColumnCacheForTests()
    await pool.query(`DELETE FROM ${SCHEMA}.job`)
  })

  afterEach(() => {
    _resetBlockedColumnCacheForTests()
  })

  test("empty queues report size 0 and latency 0", async () => {
    expect(await jobQueueSize(sampleOpts)).toBe(0)
    expect(await jobQueueSize("email", sampleOpts)).toBe(0)
    expect(await jobQueueLatency(sampleOpts)).toBe(0)
    expect(await jobQueueLatency("email", sampleOpts)).toBe(0)
  })

  test("live created jobs count toward size and ageable latency", async () => {
    const id = await insertJob(pool, { name: "email" })
    await setStartAfter(pool, id, -8)
    const rows = await jobStates(pool)
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe("created")
    expect(rows[0].age_from_start_after).toBeGreaterThanOrEqual(5)

    expect(await jobQueueSize("email", sampleOpts)).toBe(1)
    expect(await jobQueueSize(sampleOpts)).toBe(1)
    const latency = await jobQueueLatency("email", sampleOpts)
    expect(typeof latency).toBe("number")
    expect(latency).toBeGreaterThanOrEqual(5)
    expect(latency).toBeLessThan(60)
  })

  test("future start_after is excluded until due", async () => {
    const id = await insertJob(pool, {
      name: "email",
      startAfterSeconds: 3600,
    })
    const before = await jobStates(pool)
    expect(before[0].age_from_start_after).toBeLessThan(0)
    expect(await jobQueueSize("email", sampleOpts)).toBe(0)
    expect(await jobQueueLatency("email", sampleOpts)).toBe(0)

    await setStartAfter(pool, id, -5)
    const after = await jobStates(pool)
    expect(after[0].age_from_start_after).toBeGreaterThanOrEqual(4)
    expect(await jobQueueSize("email", sampleOpts)).toBe(1)
    const latency = await jobQueueLatency("email", sampleOpts)
    expect(latency).toBeGreaterThanOrEqual(4)
  })

  test("active jobs are excluded from size and latency", async () => {
    const id = await insertJob(pool, { name: "email", state: "active" })
    await setStartAfter(pool, id, -300)
    const rows = await jobStates(pool)
    expect(rows[0].state).toBe("active")
    expect(rows[0].age_from_start_after).toBeGreaterThanOrEqual(200)
    expect(await jobQueueSize("email", sampleOpts)).toBe(0)
    expect(await jobQueueLatency("email", sampleOpts)).toBe(0)
  })

  test("terminal states alone are excluded from size and latency", async () => {
    for (const state of ["completed", "cancelled", "failed"]) {
      const id = await insertJob(pool, { name: "email", state })
      await setStartAfter(pool, id, -300)
    }
    const rows = await jobStates(pool)
    expect(rows.map((r) => r.state).sort()).toEqual([
      "cancelled",
      "completed",
      "failed",
    ])
    expect(rows.every((r) => r.age_from_start_after >= 200)).toBe(true)

    expect(await jobQueueSize("email", sampleOpts)).toBe(0)
    expect(await jobQueueSize(sampleOpts)).toBe(0)
    expect(await jobQueueLatency("email", sampleOpts)).toBe(0)
    expect(await jobQueueLatency(sampleOpts)).toBe(0)
  })

  test("terminal states mixed with live count only waiting", async () => {
    await insertJob(pool, { name: "email", state: "completed" })
    await insertJob(pool, { name: "email", state: "cancelled" })
    await insertJob(pool, { name: "email", state: "failed" })
    const liveId = await insertJob(pool, { name: "email", state: "created" })
    await setStartAfter(pool, liveId, -3)

    expect(await jobQueueSize("email", sampleOpts)).toBe(1)
    expect(await jobQueueLatency("email", sampleOpts)).toBeGreaterThanOrEqual(2)

    const after = await jobStates(pool)
    expect(after.map((r) => r.state).sort()).toEqual([
      "cancelled",
      "completed",
      "created",
      "failed",
    ])
  })

  test("mixed live due future and active counts only waiting", async () => {
    await insertJob(pool, { name: "email" })
    const dueId = await insertJob(pool, { name: "email" })
    await setStartAfter(pool, dueId, -10)
    await insertJob(pool, { name: "email", startAfterSeconds: 7200 })
    await insertJob(pool, { name: "email", state: "active" })

    const rows = await jobStates(pool)
    expect(rows).toHaveLength(4)
    const future = rows.filter((r) => r.age_from_start_after < 0)
    const active = rows.filter((r) => r.state === "active")
    expect(future).toHaveLength(1)
    expect(active).toHaveLength(1)

    expect(await jobQueueSize("email", sampleOpts)).toBe(2)
    expect(await jobQueueSize(sampleOpts)).toBe(2)
  })

  test("due retry is included and future retry is excluded", async () => {
    const dueRetry = await insertJob(pool, { name: "email", state: "retry" })
    await setStartAfter(pool, dueRetry, -15)
    await insertJob(pool, {
      name: "email",
      state: "retry",
      startAfterSeconds: 600,
    })

    const rows = await jobStates(pool)
    expect(rows.every((r) => r.state === "retry")).toBe(true)
    expect(rows.filter((r) => r.age_from_start_after >= 0)).toHaveLength(1)

    expect(await jobQueueSize("email", sampleOpts)).toBe(1)
    const latency = await jobQueueLatency("email", sampleOpts)
    expect(latency).toBeGreaterThanOrEqual(10)
  })

  test("multi-queue filter and all-queues empty list", async () => {
    await insertJob(pool, { name: "email" })
    await insertJob(pool, { name: "email" })
    await insertJob(pool, { name: "sms" })

    expect(await jobQueueSize("email", sampleOpts)).toBe(2)
    expect(await jobQueueSize("sms", sampleOpts)).toBe(1)
    expect(await jobQueueSize("email", "sms", sampleOpts)).toBe(3)
    expect(await jobQueueSize(sampleOpts)).toBe(3)
    expect(await jobQueueSize("unknown_queue", sampleOpts)).toBe(0)
  })

  test("blank queue names are dropped so empty list measures all queues", async () => {
    await insertJob(pool, { name: "email" })
    await insertJob(pool, { name: "sms" })
    expect(await jobQueueSize("  ", "", null, undefined, sampleOpts)).toBe(2)
    expect(await jobQueueSize("email", "  ", sampleOpts)).toBe(1)
  })

  test("latency uses earliest due start_after not created_on", async () => {
    const older = await insertJob(pool, { name: "email" })
    const newer = await insertJob(pool, { name: "email" })
    await setStartAfter(pool, older, -12)
    await setStartAfter(pool, newer, -5)
    await setCreatedOn(pool, older, -7200)
    await setCreatedOn(pool, newer, -7200)

    const rows = await jobStates(pool)
    const olderRow = rows.find((r) => r.id === older)
    const newerRow = rows.find((r) => r.id === newer)
    expect(olderRow.age_from_created_on).toBeGreaterThan(7000)
    expect(newerRow.age_from_created_on).toBeGreaterThan(7000)
    expect(olderRow.age_from_start_after).toBeGreaterThanOrEqual(8)
    expect(olderRow.age_from_start_after).toBeLessThan(30)

    const latency = await jobQueueLatency("email", sampleOpts)
    expect(latency).toBeGreaterThanOrEqual(8)
    expect(latency).toBeLessThan(30)
  })

  test("multi-queue latency is max age across named queues", async () => {
    const emailOld = await insertJob(pool, { name: "email" })
    const smsNewer = await insertJob(pool, { name: "sms" })
    await setStartAfter(pool, emailOld, -50)
    await setStartAfter(pool, smsNewer, -12)

    const both = await jobQueueLatency("email", "sms", sampleOpts)
    expect(both).toBeGreaterThanOrEqual(45)
    expect(both).toBeLessThan(90)
    const smsOnly = await jobQueueLatency("sms", sampleOpts)
    expect(smsOnly).toBeGreaterThanOrEqual(10)
    expect(smsOnly).toBeLessThan(30)
    const all = await jobQueueLatency(sampleOpts)
    expect(all).toBeGreaterThanOrEqual(45)
    expect(all).toBeLessThan(90)
  })

  test("blocked jobs are excluded when the column exists", async () => {
    const version = installedPgBossVersion()
    const has = await hasBlockedColumn(pool)
    if (expectsBlockedColumn(version)) {
      expect(has).toBe(true)
    } else if (!has) {
      const id = await insertJob(pool, { name: "email" })
      await setStartAfter(pool, id, -6)
      expect(await jobQueueSize("email", sampleOpts)).toBe(1)
      expect(await jobQueueLatency("email", sampleOpts)).toBeGreaterThanOrEqual(
        4,
      )
      return
    }

    await insertJob(pool, { name: "email", blocked: false })
    await insertJob(pool, { name: "email", blocked: false })
    const blockedId = await insertJob(pool, {
      name: "email",
      blocked: true,
    })
    await setStartAfter(pool, blockedId, -30)

    const rows = await jobStates(pool)
    expect(rows.filter((r) => r.blocked === true)).toHaveLength(1)
    expect(rows.filter((r) => r.blocked === false)).toHaveLength(2)

    expect(await jobQueueSize("email", sampleOpts)).toBe(2)
    expect(await jobQueueSize(sampleOpts)).toBe(2)

    const latency = await jobQueueLatency("email", sampleOpts)
    expect(latency).toBeLessThan(20)
  })

  test("blocked-only queue reports size 0 and latency 0 when column exists", async () => {
    const has = await hasBlockedColumn(pool)
    if (!has) {
      const id = await insertJob(pool, { name: "email" })
      await setStartAfter(pool, id, -6)
      expect(await jobQueueSize("email", sampleOpts)).toBe(1)
      expect(await jobQueueLatency("email", sampleOpts)).toBeGreaterThanOrEqual(
        4,
      )
      return
    }

    const id = await insertJob(pool, { name: "email", blocked: true })
    await setStartAfter(pool, id, -45)
    const rows = await jobStates(pool)
    expect(rows).toHaveLength(1)
    expect(rows[0].blocked).toBe(true)
    expect(rows[0].age_from_start_after).toBeGreaterThanOrEqual(40)

    expect(await jobQueueSize("email", sampleOpts)).toBe(0)
    expect(await jobQueueSize(sampleOpts)).toBe(0)
    expect(await jobQueueLatency("email", sampleOpts)).toBe(0)
    expect(await jobQueueLatency(sampleOpts)).toBe(0)
  })

  test("connection URL option, borrowed pool, and options.pool", async () => {
    await insertJob(pool, { name: "email" })
    expect(
      await jobQueueSize("email", {
        connection: postgresURL,
        schema: SCHEMA,
      }),
    ).toBe(1)

    const borrowed = new Pool({ connectionString: postgresURL, max: 1 })
    try {
      expect(
        await jobQueueSize("email", {
          connection: borrowed,
          schema: SCHEMA,
        }),
      ).toBe(1)
      expect(
        await jobQueueSize("email", {
          pool: borrowed,
          schema: SCHEMA,
        }),
      ).toBe(1)
      const { rows } = await borrowed.query("SELECT 1 AS ok")
      expect(rows[0].ok).toBe(1)
    } finally {
      await borrowed.end()
    }
  })

  test("HIREFIRE_PG_BOSS_URL wins when DATABASE_URL is also set", async () => {
    await insertJob(pool, { name: "email" })
    await withEnv(
      {
        HIREFIRE_PG_BOSS_URL: postgresURL,
        HIREFIRE_PG_BOSS_SCHEMA: SCHEMA,
        DATABASE_URL: "postgres://postgres@127.0.0.1:1/not_used",
      },
      async () => {
        expect(await jobQueueSize("email")).toBe(1)
        expect(await jobQueueLatency("email")).toBeGreaterThanOrEqual(0)
      },
    )
  })

  test("blank HIREFIRE_PG_BOSS_URL falls through to DATABASE_URL", async () => {
    await insertJob(pool, { name: "email" })
    await withEnv(
      {
        HIREFIRE_PG_BOSS_URL: "   ",
        DATABASE_URL: postgresURL,
        HIREFIRE_PG_BOSS_SCHEMA: SCHEMA,
      },
      async () => {
        expect(await jobQueueSize("email")).toBe(1)
      },
    )
  })

  test("samples via DATABASE_URL when HIREFIRE_PG_BOSS_URL is unset", async () => {
    await insertJob(pool, { name: "email" })
    await withEnv(
      {
        HIREFIRE_PG_BOSS_URL: undefined,
        DATABASE_URL: postgresURL,
        HIREFIRE_PG_BOSS_SCHEMA: SCHEMA,
      },
      async () => {
        expect(await jobQueueSize("email")).toBe(1)
      },
    )
  })

  test("options.schema wins over HIREFIRE_PG_BOSS_SCHEMA", async () => {
    await insertJob(pool, { name: "email" })
    await withEnv(
      {
        HIREFIRE_PG_BOSS_SCHEMA: "wrong_schema_that_does_not_exist",
      },
      async () => {
        expect(
          await jobQueueSize("email", {
            connection: postgresURL,
            schema: SCHEMA,
          }),
        ).toBe(1)
      },
    )
  })

  test("schema from HIREFIRE_PG_BOSS_SCHEMA when options omit schema", async () => {
    await insertJob(pool, { name: "email" })
    await withEnv(
      {
        HIREFIRE_PG_BOSS_SCHEMA: SCHEMA,
      },
      async () => {
        expect(await jobQueueSize("email", { connection: postgresURL })).toBe(1)
      },
    )
  })

  test("invalid schema name is rejected", async () => {
    await expect(
      jobQueueSize("email", { connection: postgresURL, schema: "bad-name!" }),
    ).rejects.toThrow(/Invalid pg-boss schema name/)
    await expect(
      jobQueueLatency({
        connection: postgresURL,
        schema: "1starts_with_digit",
      }),
    ).rejects.toThrow(/Invalid pg-boss schema name/)
  })

  test("sampling never claims jobs or changes state", async () => {
    const id = await insertJob(pool, { name: "email" })
    await setStartAfter(pool, id, -7)
    expect(await jobQueueSize("email", sampleOpts)).toBe(1)
    expect(await jobQueueLatency("email", sampleOpts)).toBeGreaterThanOrEqual(5)
    expect(await jobQueueSize("email", sampleOpts)).toBe(1)

    const { rows } = await pool.query(
      `SELECT state::text AS state,
              EXTRACT(EPOCH FROM (now() - start_after))::float8 AS age
         FROM ${SCHEMA}.job WHERE id = $1`,
      [id],
    )
    expect(rows[0].state).toBe("created")
    expect(rows[0].age).toBeGreaterThanOrEqual(5)
  })

  test("plan path samples jqs and jql", async () => {
    await insertJob(pool, { name: "email" })
    const older = await insertJob(pool, { name: "sms" })
    await setStartAfter(pool, older, -20)

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }

    await withEnv(
      {
        HIREFIRE_PG_BOSS_URL: postgresURL,
        HIREFIRE_PG_BOSS_SCHEMA: SCHEMA,
      },
      async () => {
        await Plan.execute(
          {
            name: "worker",
            adapter: "pg_boss",
            strategy: "jqs",
            queues: ["email", "sms"],
          },
          configuration,
        )
        await Plan.execute(
          {
            name: "worker",
            adapter: "pg_boss",
            strategy: "jql",
            queues: ["sms"],
          },
          configuration,
        )

        const flushed = configuration.buffer.flush()
        expect(flushed.worker).toBeDefined()
        expect(flushed.worker.jqs).toBeDefined()
        expect(flushed.worker.jql).toBeDefined()
        const jqsValues = Object.values(flushed.worker.jqs)
        const jqlValues = Object.values(flushed.worker.jql)
        expect(jqsValues[0]).toBe(2)
        expect(jqlValues[0]).toBeGreaterThanOrEqual(15)
      },
    )
  })

  test("jobQueueWorking idle is zero", async () => {
    expect(await jobQueueWorking(sampleOpts)).toBe(0)
    expect(await jobQueueWorking("email", sampleOpts)).toBe(0)
  })

  test("jobQueueWorking counts active and filters queues", async () => {
    await insertJob(pool, { name: "email", state: "active" })
    await insertJob(pool, { name: "sms", state: "active" })
    await insertJob(pool, { name: "sms", state: "active" })
    await insertJob(pool, { name: "email", state: "created" })

    expect(await jobQueueWorking(sampleOpts)).toBe(3)
    expect(await jobQueueWorking("email", sampleOpts)).toBe(1)
    expect(await jobQueueWorking("sms", sampleOpts)).toBe(2)
    expect(await jobQueueWorking("critical", sampleOpts)).toBe(0)
    expect(await jobQueueWorking("email", "sms", sampleOpts)).toBe(3)
    expect(await jobQueueSize("email", sampleOpts)).toBe(1)
    expect(await jobQueueSize("sms", sampleOpts)).toBe(0)
  })

  test("plan path samples wrk companion with jqs and jql", async () => {
    await insertJob(pool, { name: "email", state: "active" })
    await insertJob(pool, { name: "email", state: "created" })
    await insertJob(pool, { name: "sms", state: "active" })

    const configuration = new Configuration()
    configuration.logger = { info() {}, warn() {}, error: jest.fn() }

    await withEnv(
      {
        HIREFIRE_PG_BOSS_URL: postgresURL,
        HIREFIRE_PG_BOSS_SCHEMA: SCHEMA,
      },
      async () => {
        await Plan.execute(
          {
            name: "worker",
            adapter: "pg_boss",
            strategy: "jqs",
            queues: ["email"],
          },
          configuration,
        )
        let flushed = configuration.buffer.flush()
        expect(Object.values(flushed.worker.jqs)[0]).toBe(1)
        expect(Object.values(flushed.worker.wrk)[0]).toBe(1)
        expect(Object.values(flushed.worker.wrk)[0]).toBe(
          await jobQueueWorking("email", sampleOpts),
        )

        await Plan.execute(
          {
            name: "worker",
            adapter: "pg_boss",
            strategy: "jql",
            queues: [],
          },
          configuration,
        )
        flushed = configuration.buffer.flush()
        expect(flushed.worker.jql).toBeDefined()
        expect(Object.values(flushed.worker.wrk)[0]).toBe(2)
        expect(Object.values(flushed.worker.wrk)[0]).toBe(
          await jobQueueWorking(sampleOpts),
        )
      },
    )
  })
})
