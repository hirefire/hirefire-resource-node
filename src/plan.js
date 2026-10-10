const Adapter = require("./plan/adapter")
const safeLog = require("./log")
const { formatError } = safeLog
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

  async aroundJobQueueSample(logger, fn) {
    const tokens = new Map()
    await eachHook(logger, "beforeSampleJobQueues", async (name, hook) => {
      tokens.set(name, await hook())
    })

    try {
      return await fn()
    } finally {
      await eachHook(logger, "afterSampleJobQueues", async (name, hook) => {
        if (tokens.has(name)) await hook(tokens.get(name))
      })
    }
  },
}

async function eachHook(logger, hook, fn) {
  for (const [name, adapter] of Object.entries(Plan.ADAPTERS)) {
    try {
      const macro = adapter.macro
      if (typeof macro[hook] === "function") await fn(name, macro[hook])
    } catch (error) {
      safeLog(
        logger,
        "error",
        `[HireFire] ${hook} for ${JSON.stringify(name)} raised ` +
          formatError(error),
      )
    }
  }
}

module.exports = Plan
