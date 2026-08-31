# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The library now pushes metrics to `https://data.hirefire.io`. HireFire no longer polls the app.
- Request queue time is sampled from HTTP traffic through the middleware. A web `dyno` line is not required.
- CPU activity is sampled automatically.
- Optional token-only setup with `HireFire.boot()`. Existing `config.dyno` job queue blocks still work.
- Count of jobs still being processed (`jobQueueWorking`) for BullMQ, classic Bull, and pg-boss.
- Classic Bull: job queue size only. Job queue latency is unsupported.
- pg-boss 10 to 12: job queue size and job queue latency. Dependency-blocked jobs are excluded on schemas that track them. Versions 11 and 12 require Node.js 22+.
- Support Node.js 22, 24, and 26.
- Support Express 5, Fastify 5, Koa 3, Nest 11 and 12, Next.js 15 and 16, and BullMQ 5 and 6.
- The package now ships TypeScript declarations.

### Changed

- TypeScript declarations are handwritten `.d.ts` files shipped with the package, not generated from JSDoc.
- Metrics are sent only when `HIREFIRE_TOKEN` is set.
- Job queue metrics are sampled by one process at a time.
- Job queue macros count queued jobs plus scheduled or retry jobs that are due. Jobs already being processed are no longer included in job queue size or job queue latency.
- BullMQ job queue size no longer counts active jobs.
- Required Node.js is 20+. Official Express support is 4+.

### Deprecated

- Bare `config.dyno("web")` (no sampler) is deprecated. It does nothing. Request queue time is sampled automatically from HTTP traffic. You can remove the line. Leaving it does not break anything.

### Removed

- Serving `GET /hirefire/:token/info`.
- `POST` of request queue time JSON to `logdrain.hirefire.io`.
- Official support for Node.js 16 and 18.

### Fixed

- A globally paused BullMQ 4 queue no longer counts the pause marker as a queued job.
- BullMQ and classic Bull sampling now require `ioredis`. Without it, those job metrics are not collected.

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
