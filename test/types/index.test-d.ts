import { expectError, expectType } from "tsd"
import HireFire = require("../../types")
import Configuration = require("../../types/configuration")
import expressMiddleware = require("../../types/middleware/express")
import connectMiddleware = require("../../types/middleware/connect")
import koaMiddleware = require("../../types/middleware/koa")
import fastifyMiddleware = require("../../types/middleware/fastify")
import nextMiddleware = require("../../types/middleware/next")
import bullmq = require("../../types/macro/bullmq")
import bull = require("../../types/macro/bull")
import pgBoss = require("../../types/macro/pg_boss")
import errors = require("../../types/errors")

const configuration = HireFire.configuration

expectType<string | null>(configuration.token)
expectType<string | null>(configuration.httpName)
configuration.token = "token"
configuration.token = null

expectType<typeof configuration>(
  HireFire.configure((config) => {
    expectType<void>(config.dyno("web"))
    expectType<void>(config.dyno("worker", () => 1))
  }),
)
expectType<typeof configuration>(HireFire.boot())
expectType<Promise<boolean>>(HireFire.reset())

expectError(configuration.dyno())
expectError(configuration.dyno("worker", "not-a-sampler"))
expectError(configuration.dyno("worker", 1))

expectType<boolean>(configuration.dispatcher.start())
expectType<void>(configuration.dispatcher.ensureJobQueueLoop())
expectType<boolean>(configuration.dispatcher.running())
expectType<void>(configuration.markHttpActive())
expectType<boolean>(configuration.rqtEnabled)
expectType<boolean>(configuration.rqtLiveness)
expectType<object[]>(configuration.activeCpuSources())

expectType<typeof errors.MissingQueueError>(errors.MissingQueueError)
expectType<typeof errors.JobQueueLatencyUnsupportedError>(
  errors.JobQueueLatencyUnsupportedError,
)

expectType<typeof Configuration.MissingSamplerError>(
  Configuration.MissingSamplerError,
)
expectType<typeof Configuration.DuplicateDynoError>(
  Configuration.DuplicateDynoError,
)

const next = () => {}
expectType<void>(expressMiddleware({}, {}, next))
expectType<void>(connectMiddleware({}, {}, next))
expectType<Promise<void>>(
  koaMiddleware({ request: { headers: {} } }, async () => {}),
)
expectType<Promise<void>>(fastifyMiddleware({}, {}))
expectType<(nextRequest: any) => any>(nextMiddleware.middleware)
expectType<
  (
    userMiddleware: nextMiddleware.NextMiddleware,
  ) => nextMiddleware.NextMiddleware
>(nextMiddleware.withHireFire)

expectType<Promise<number>>(bullmq.jobQueueSize())
expectType<Promise<number>>(bullmq.jobQueueSize("default"))
expectType<Promise<number>>(
  bullmq.jobQueueSize("default", { connection: "redis://localhost:6379/0" }),
)
expectType<Promise<number>>(bullmq.jobQueueWorking())
expectType<Promise<number>>(bullmq.jobQueueWorking("default"))
expectType<Promise<never>>(bullmq.jobQueueLatency())
expectType<boolean>(bullmq.queuesRequired())
expectType<typeof bullmq.JobQueueLatencyUnsupportedError>(
  bullmq.JobQueueLatencyUnsupportedError,
)

expectType<Promise<number>>(bull.jobQueueSize("default"))
expectType<Promise<number>>(bull.jobQueueWorking("default"))
expectType<Promise<never>>(bull.jobQueueLatency())
expectType<boolean>(bull.queuesRequired())

expectType<Promise<number>>(pgBoss.jobQueueSize("default"))
expectType<Promise<number>>(pgBoss.jobQueueLatency("default"))
expectType<Promise<number>>(pgBoss.jobQueueWorking("default"))
expectType<Promise<number>>(
  pgBoss.jobQueueWorking("default", { connection: "postgres://localhost/db" }),
)
expectType<Promise<number>>(
  pgBoss.jobQueueSize("default", {
    connection: { query: () => Promise.resolve() },
  }),
)
expectType<Promise<number>>(
  pgBoss.jobQueueSize("default", { pool: { query: () => Promise.resolve() } }),
)
expectError(
  pgBoss.jobQueueSize("default", { connection: { host: "127.0.0.1" } }),
)
expectError(pgBoss.jobQueueSize("default", { pool: { host: "127.0.0.1" } }))
expectType<boolean>(pgBoss.queuesRequired())

expectError(bullmq.jobQueueSize(1))
expectError(bull.jobQueueSize({ not: "a-queue" }))
