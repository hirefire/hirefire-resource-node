import * as pgBossModule from "pg-boss"
import pg from "pg"

const PgBoss = pgBossModule.PgBoss || pgBossModule.default || pgBossModule

const [url, schema, ...queues] = process.argv.slice(2)
if (!url || !schema || queues.length === 0) {
  console.error(
    "usage: node tools/lib/pg_boss_seed.mjs <url> <schema> <queue>=<jobs>...",
  )
  process.exit(2)
}

const client = new pg.Client({ connectionString: url })
await client.connect()
await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
await client.end()

const boss = new PgBoss({ connectionString: url, schema })
boss.on("error", () => {})
try {
  await boss.start()
  for (const queue of queues) {
    const [name, count] = queue.split("=")
    await boss.createQueue(name)
    for (let index = 0; index < Number(count || 0); index += 1) {
      await boss.send(name, {})
    }
  }
} finally {
  try {
    await boss.stop({ graceful: false, timeout: 2_000 })
  } catch {}
}
