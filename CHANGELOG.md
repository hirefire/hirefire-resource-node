# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Push job-queue and request-queue-time metrics to `https://data.hirefire.io` (lease plus nested ingest) so HireFire no longer polls the app.
- Always-on request queue time on the HTTP middleware path, and always-on CPU when process identity resolves (`DYNO`, `HIREFIRE_SERVICE_NAME`, or `RENDER_SERVICE_NAME`).
- `HireFire.boot()` for token-only zero-config. Local `config.dyno` job-queue samplers remain for custom probes and root installs.
- Job-queue working count (`jobQueueWorking`) and nested `wrk` beside `jql`/`jqs` for BullMQ, classic Bull, and pg-boss.
- Lease collection plans: the server grant can drive allowlisted macros (`bullmq`, `bull`, `pg_boss`). Strategy-only entries still run the matching local `config.dyno` sampler.
- Classic Bull (OptimalBits/`bull`) adapter: waiting-only `jobQueueSize` (`wait` plus `paused` plus due `delayed`). Job queue latency is unsupported.
- pg-boss adapter (`pg_boss` plan key): waiting-only size and latency via read-only SQL. Official support is pg-boss 10 to 12.

### Changed

- Job-queue macros count only the waiting set (live plus due scheduled plus due retry). In-flight jobs are no longer included in JQL or JQS.
- BullMQ `jobQueueSize` is waiting-only: live (`wait` plus `paused` plus `prioritized`) plus due delayed. Active jobs are no longer counted. JQL stays unsupported.
- Required Node.js is 20+ (was 16, with an upper bound below 22).

### Deprecated

- `config.logQueueMetrics = true` still prints `[hirefire:router] queue=<N>ms` for Logplex QueueTime. Setting it once-warns to prefer HireFire Request Queue Time plus `HIREFIRE_TOKEN`.
- Bare `config.dyno("web")` (no sampler) is a once-warn no-op. Request queue time is armed by platform web identity and HTTP middleware traffic.

### Removed

- Serving `GET /hirefire/:token/info`. Job metrics are push-only.
- Official support for Node.js 16 and 18.

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
