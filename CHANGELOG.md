# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Job metrics are pushed to HireFire instead of being read from a poll of the app.
- CPU activity is sampled automatically on supported platforms when the process is identified.
- `HireFire.boot()` starts metric collection when a token is set. `HireFire.reset()` stops the dispatcher and clears configuration.
- `config.token` can set the HireFire token in code. 1.x read only `HIREFIRE_TOKEN`.
- `HIREFIRE_SERVICE_NAME` sets the process name only on platforms that do not detect it automatically. On Heroku, `DYNO` is used.
- `HIREFIRE_BULLMQ_URL` and `HIREFIRE_BULL_URL` set the Redis URL for BullMQ and classic Bull samples. `HIREFIRE_PG_BOSS_URL` and `HIREFIRE_PG_BOSS_SCHEMA` set the Postgres URL and schema for pg-boss samples.
- `jobQueueWorking` reports how many jobs are currently in progress for BullMQ, classic Bull, and pg-boss.
- Classic Bull job queue size (latency is unsupported).
- pg-boss 10 to 12: job queue size and job queue latency. Dependency-blocked jobs are excluded on schemas that track them. Versions 11 and 12 require Node.js 22+.
- Support Node.js 22+.
- Support Express 5, Fastify 5, Koa 3, Nest 11 and 12, Next.js 15 and 16, and BullMQ 5 and 6.
- The package now ships TypeScript declarations.

### Changed

- Request queue time is sampled automatically from HTTP traffic. `config.dyno("web")` is not required.
- BullMQ `jobQueueSize` no longer includes jobs already being processed.
- BullMQ and classic Bull sampling require the app's `ioredis` package as an optional peer. Without it, those job metrics are not collected.
- Official Node.js support is 20+.
- Process names may be any non-empty string up to 128 bytes. The 1.x letter-start charset and 30-character cap are gone.
- `config.dyno` without a sampler raises `MissingSamplerError` except when the name is `"web"` (1.x raised `MissingDynoFnError`). Duplicate dyno names raise `DuplicateDynoError`.
- `HireFire.configure` callbacks must be synchronous.

### Deprecated

- Bare `config.dyno("web")` (no sampler) is deprecated. It does nothing. Request queue time is sampled automatically from HTTP traffic. The line can be removed. Leaving it does not break anything.

### Removed

- Serving `GET /hirefire/:token/info` and `GET /hirefire` when the token matched.
- Official support for Node.js 16 through 19.

### Fixed

- Request queue time ignores samples older than 60 seconds.
- BullMQ `jobQueueSize` includes paused and prioritized jobs (1.x omitted both).
- HTTP requests to HireFire time out within five seconds even when DNS never completes.
- BullMQ samples fail within five seconds when Redis does not respond.
- BullMQ samples with no queue names use Redis `SCAN` instead of `KEYS`.

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
