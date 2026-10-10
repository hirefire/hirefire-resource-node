const Adapter = require("./plan/adapter")
const { JQL, JQS } = require("./strategy")

const Plan = {
  ADAPTERS: {
    bull: new Adapter({
      macro: () => require("./macro/bull"),
      packages: ["bull", "ioredis"],
      strategies: [JQS],
      environment: { connection: "HIREFIRE_BULL_URL" },
    }),
    bullmq: new Adapter({
      macro: () => require("./macro/bullmq"),
      packages: ["bullmq", "ioredis"],
      strategies: [JQS],
      environment: { connection: "HIREFIRE_BULLMQ_URL" },
    }),
    pg_boss: new Adapter({
      macro: () => require("./macro/pg_boss"),
      packages: ["pg-boss", "pg"],
      strategies: [JQL, JQS],
      environment: {
        connection: "HIREFIRE_PG_BOSS_URL",
        schema: "HIREFIRE_PG_BOSS_SCHEMA",
      },
    }),
  },

  MAX_QUEUES: 64,
  MAX_QUEUE_NAME_BYTES: 128,

  adapter(name) {
    return Object.hasOwn(this.ADAPTERS, name) ? this.ADAPTERS[name] : null
  },

  anyLibraryLoaded() {
    return Object.values(this.ADAPTERS).some((adapter) =>
      adapter.libraryLoaded(),
    )
  },
}

module.exports = Plan
