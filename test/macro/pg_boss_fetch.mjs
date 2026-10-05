import * as pgBossModule from "pg-boss"

const PgBoss = pgBossModule.PgBoss || pgBossModule.default || pgBossModule

const [url, schema, queue] = process.argv.slice(2)
if (!url || !schema || !queue) {
  console.error(
    "usage: node test/macro/pg_boss_fetch.mjs <url> <schema> <queue>",
  )
  process.exit(2)
}

const boss = new PgBoss({ connectionString: url, schema })
try {
  await boss.start()
  await boss.send(queue, {})
  await boss.fetch(queue)
} finally {
  try {
    await boss.stop({ graceful: false, timeout: 2_000 })
  } catch {}
}
