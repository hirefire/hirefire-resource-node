// ESM-compatible setup for Jest CJS cells (pg-boss 12 is type:module).
// Usage: node test/macro/pg_boss_setup.mjs <postgresURL> <schema> <queue1> [queue2...]
// v12 exports named { PgBoss }. Older CJS majors surface as default under import.
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
  // Nested teardown: always stop even if createQueue fails mid-loop.
  try {
    await boss.stop({ graceful: false, timeout: 2_000 })
  } catch {
    // ignore stop failures during setup abort
  }
}
