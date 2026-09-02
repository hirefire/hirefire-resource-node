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
import JobQueue = require("../../types/source/jobQueue")

const configuration = HireFire.configuration

expectType<string | null>(configuration.token)
expectType<string | null>(configuration.httpName)
expectType<string | undefined>(configuration.http?.name)
expectType<number>(Configuration.MAX_NAME_BYTES)
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
expectError(configuration.service)
expectError(configuration.tracking)
expectError(HireFire.Web)
expectError(HireFire.Worker)
expectError(HireFire.Workers)

expectType<boolean>(configuration.dispatcher.start())
expectType<void>(configuration.dispatcher.ensureJobQueueLoop())
expectType<boolean>(configuration.dispatcher.running())
expectType<Promise<boolean>>(configuration.dispatcher.stop())
expectType<Promise<boolean>>(configuration.dispatcher.stop({ flush: false }))
expectType<void>(configuration.markHttpActive())
expectType<boolean>(configuration.rqtEnabled)
expectType<boolean>(configuration.rqtLiveness)

expectType<void>(configuration.buffer.sample("web", "rqt", 1))
expectType<{
  [name: string]: {
    [strategy: string]: {
      [timestamp: string]: number | { sum: number; count: number }
    }
  }
}>(configuration.buffer.flush())
expectType<void>(configuration.buffer.discardInherited())
expectType<void>(
  configuration.buffer.repopulate("web", "rqt", {
    "1": { sum: 1, count: 1 },
  }),
)

expectType<boolean>(configuration.jobQueues.any())
expectType<(jobQueue: JobQueue) => void>(configuration.jobQueues.add)
expectType<
  (
    jobQueue: JobQueue | null | undefined,
    strategy: string,
    options?: { live?: () => boolean; name?: string },
  ) => Promise<void>
>(configuration.jobQueues.sampleJobQueue)
const found = configuration.jobQueues.findByName("worker")
if (found) {
  expectType<string>(found.name)
  expectType<number | Promise<number>>(found.sample())
} else {
  expectType<null>(found)
}
for (const queue of configuration.jobQueues) {
  expectType<string>(queue.name)
  expectType<number | Promise<number>>(queue.sample())
}
const queueIterator = configuration.jobQueues[Symbol.iterator]()
const queueStep = queueIterator.next()
if (!queueStep.done) {
  expectType<string>(queueStep.value.name)
  expectType<number | Promise<number>>(queueStep.value.sample())
}

const httpSource = configuration.httpSource
if (httpSource) {
  expectType<string>(httpSource.name)
  expectType<void>(httpSource.sample(12))
} else {
  expectType<null>(httpSource)
}

const cpus = configuration.activeCpuSources()
expectType<string>(cpus[0].name)
expectType<void | null>(cpus[0].sample())

expectType<typeof errors.MissingQueueError>(errors.MissingQueueError)
expectType<typeof errors.JobQueueLatencyUnsupportedError>(
  errors.JobQueueLatencyUnsupportedError,
)
expectType<(name: string) => never>(errors.jobQueueLatencyUnsupported)
expectType<never>(errors.jobQueueLatencyUnsupported("Bull"))
expectType<errors.MissingQueueError>(new errors.MissingQueueError())
expectType<errors.JobQueueLatencyUnsupportedError>(
  new errors.JobQueueLatencyUnsupportedError("BullMQ"),
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
expectType<boolean>(bullmq.supportsPlanStrategy("jqs"))
expectType<object>(bullmq.planOptions("jqs", {}))
expectType<object>(bullmq.planConnectionOptions())
expectType<true>(bullmq.beforeSampleJobQueues())
expectType<void>(bullmq.afterSampleJobQueues())
expectType<void>(bullmq.reinitAfterFork())
expectType<typeof bullmq.JobQueueLatencyUnsupportedError>(
  bullmq.JobQueueLatencyUnsupportedError,
)

expectType<Promise<number>>(bull.jobQueueSize("default"))
expectType<Promise<number>>(bull.jobQueueWorking("default"))
expectType<Promise<never>>(bull.jobQueueLatency())
expectType<boolean>(bull.queuesRequired())
expectType<typeof bull.JobQueueLatencyUnsupportedError>(
  bull.JobQueueLatencyUnsupportedError,
)

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
