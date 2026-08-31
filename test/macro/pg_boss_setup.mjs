import * as pgBossModule from "pg-boss"

const PgBoss = pgBossModule.PgBoss || pgBossModule.default || pgBossModule

const [url, schema, ...queues] = process.argv.slice(2)
if (!url || !schema || queues.length === 0) {
  console.error(
    "usage: node test/macro/pg_boss_setup.mjs <url> <schema> <queue>...",
  )
  process.exit(2)
}

const boss = new PgBoss({ connectionString: url, schema })
try {
  await boss.start()
  for (const name of queues) {
    await boss.createQueue(name)
  }
} finally {
  try {
    await boss.stop({ graceful: false, timeout: 2_000 })
  } catch {}
}
