# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Job metrics are pushed to HireFire instead of being read from a poll of the app.
- CPU activity is sampled automatically on supported platforms when the process is identified.
- `HireFire.boot()` starts metric collection when a token is set. A Heroku one-off dyno (`heroku run` and the release phase), a `cluster` primary that has forked workers, and a worker thread do not start it. `config.forceStart = true` starts it in such a primary or thread anyway. `HireFire.reset()` stops the dispatcher and clears configuration, and nothing starts again until `configure` or `boot` runs.
- `config.token` can set the HireFire token in code. 1.x read only `HIREFIRE_TOKEN`.
- `HIREFIRE_SERVICE_NAME` sets the process name and overrides the name that the platform provides. On Heroku the name comes from `DYNO`, so the variable is not needed there. A Heroku config var applies to every dyno of the app, and a warning is logged when the variable and `DYNO` disagree.
- `HIREFIRE_BULLMQ_URL` and `HIREFIRE_BULL_URL` set the Redis URL for BullMQ and classic Bull samples. `HIREFIRE_PG_BOSS_URL` and `HIREFIRE_PG_BOSS_SCHEMA` set the Postgres URL and schema for pg-boss samples.
- `jobQueueWorking` reports how many jobs are currently in progress for BullMQ, classic Bull, and pg-boss. A job whose worker is gone counts as waiting, not as in progress: on BullMQ and classic Bull an active job without its lock, on pg-boss an active job past its expiry.
- Classic Bull job queue size (latency is unsupported).
- pg-boss 10 to 12: job queue size and job queue latency. Dependency-blocked jobs are excluded on schemas that track them. Versions 11 and 12 require Node.js 22+.
- On Heroku, pg-boss samples connect to Postgres over SSL without certificate verification, as Heroku Postgres requires. `connectionOptions.ssl`, `PGSSLMODE`, or an SSL parameter in the URL sets it otherwise.
- BullMQ, classic Bull, and pg-boss `jobQueueSize` include jobs being processed, and `skipWorking: true` leaves them out.
- Support Node.js 22+.
- Support Express 5, Fastify 5, Koa 3, Nest 11 and 12, Next.js 15 and 16, and BullMQ 5 and 6.
- The package now ships TypeScript declarations.

### Changed

- Request queue time is sampled automatically from HTTP traffic. `config.dyno("web")` is not required.
- BullMQ and classic Bull sampling require the app's `ioredis` package as an optional peer. Without it, those job metrics are not collected. `bull`, `bullmq`, `ioredis`, `next`, `pg`, and `pg-boss` are declared as optional peer dependencies, and a package that is not found from the library is looked up from the working directory of the process.
- Official Node.js support is 20+.
- Next.js support starts at 15.5, on the Node.js middleware runtime. The middleware does not run on the Edge runtime, which is the only middleware runtime of Next.js 14.
- Process names may be any non-empty string up to 128 bytes. The 1.x letter-start charset and 30-character cap are gone. An invalid name throws `TypeError` (1.x threw `InvalidDynoNameError`).
- `config.dyno` without a sampler raises `MissingSamplerError` except when the name is `"web"` (1.x raised `MissingDynoFnError`). Duplicate dyno names raise `DuplicateDynoError`. Both classes are exported from `hirefire-resource/errors` and as statics of the configuration class.
- `HireFire.configure` callbacks must be synchronous.
- On Heroku, BullMQ samples over `rediss://` connect to Redis without certificate verification, as Heroku Key-Value Store requires. `connectionOptions.tls` sets it otherwise. 1.x needed that option on every sample.
- A BullMQ sample without queue names fails when listing the queues takes more than 2 seconds, and the error asks for queue names. 1.x had no limit.

### Deprecated

- Bare `config.dyno("web")` (no sampler) is deprecated. It does nothing. Request queue time is sampled automatically from HTTP traffic. The line can be removed. Leaving it does not break anything.

### Removed

- Serving `GET /hirefire/:token/info` and `GET /hirefire` when the token matched.
- Official support for Node.js 16 through 19.

### Fixed

- Request queue time ignores samples older than 60 seconds.
- The Fastify plugin works without the `fastify-plugin` package. 1.x required it and did not declare it as a dependency.
- BullMQ `jobQueueSize` includes paused and prioritized jobs (1.x omitted both).
- HTTP requests to HireFire time out within five seconds even when DNS never completes.
- BullMQ samples fail within ten seconds when Redis does not respond.
- BullMQ samples with no queue names use Redis `SCAN` instead of `KEYS`.
- An ioredis client passed as `connection` to a BullMQ sample reads the Redis of that client. 1.x read `localhost:6379`.

## [1.2.0] - 2026-02-03

### Added

- Add support for [Next.js](https://nextjs.org).

## [1.1.1] - 2025-05-06

### Added

- Add connectionOptions to BullMQ jobQueueSize

## [1.1.0] - 2024-04-21

### Added

- Add support for [Fastify](https://fastify.dev).

## [1.0.1] - 2024-03-13

### Added

- Add support for dashes in `Worker` names to match the Procfile process naming format. `Worker` is implicitly used when configuring HireFire using the `Configuration#dyno` method.

## [1.0.0] - 2024-01-24

### Added

- Initial release.
