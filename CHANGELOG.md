# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `HireFire.boot()` for zero-config installs: starts the dispatcher when a token is present with no local dyno declarations.
- Always-on request queue time (RQT) under the process identity or explicit `dyno("web")`, armed by platform web role (`DYNO` / `RENDER_SERVICE_TYPE`), middleware traffic, or an explicit HTTP registration.
- Always-on CPU metrics under the resolved process identity (no `tracking: "cpu"` declaration).
- Lease collection plans: grant bodies can drive job-queue sampling via allowlisted adapters (BullMQ `jqs`), with plan-vs-local precedence and strategy-only local dynos.
- `HireFire.configure` is additive and re-evaluates job-queue loop entry after late dyno registrations (`ensureJobQueueLoop`).
- Identity helpers: whitespace strip, Fir mixed-case dyno suffixes, `platformHttpRole`, case-insensitive web role matching.
- Token strip: whitespace-only tokens are absent. Explicit `""` still forces reporting off.
- Dispatcher lifecycle: generation fences after awaits, `stop({ flush })`, dual dispatch/job loop joins, lease demote/epoch, process id rotate when a grant cannot be sampled.
- Nested compact ingest wire: RQT as `[mean, n]` or `[]` heartbeats, bare non-RQT numbers, 32 KB payload limit.
- Plan hooks on the BullMQ macro (`planOptions`, `planConnectionOptions`, `supportsPlanStrategy`) and `HIREFIRE_BULLMQ_URL` connection override.
- JSDoc and generated TypeScript declarations for the cutover public surface (`boot`, dyno-only config, `http` / `httpName` / `rqtEnabled` / `rqtLiveness`, plan hooks).

### Changed

- Public configuration is dyno-only: `config.dyno(name)` or `config.dyno(name, sampler)`. Same name may register both HTTP and a job-queue sampler. Names strip whitespace, reject empty and over-128-byte values, and preserve first-seen casing.
- Middleware always samples when a token is present (no declared web collector required). Blank `X-Request-Start` falls through to `X-Queue-Start`.
- Payload size limit is **32 KB** (was documented as 64 KB). Oversized client payloads are dropped with a watermark advance.
- Buffer RQT accumulates sum+count. Samples ignore non-finite values. Repopulate is RQT-only with mean-preserving clamp at the sample count limit.
- `HIREFIRE_DATA_URL` strips whitespace and trailing slashes. Empty or slash-only values fall back to `https://data.hirefire.io`.
- Configuration error surface is `MissingSamplerError` and `DuplicateDynoError` only.
- BullMQ `jobQueueSize` is waiting-only: live (`wait` + `paused` + `prioritized`) plus due delayed (score ≤ now). Active (working) jobs are no longer counted. JQL stays unsupported. No `skip_working` flag (unlike Sidekiq).

### Removed

- `config.service(...)` and `{ tracking: "http" | "cpu" }` declaration paths.
- `UnexpectedSamplerError` and `UnknownCollectorError`.
- Declared multi-name CPU collector lists (`config.cpu` public array).

### Fixed

- Unresolved process identity no longer synthesizes RQT liveness heartbeats.
- Soft identity re-resolves on every access and rebuilds always-on HTTP/CPU sources when the identity name changes.
- BullMQ `jobQueueSize` counts `prioritized` and `paused` queues (and discovers them via SCAN), so priority and paused backlog are no longer undercounted. Pipeline command errors are treated as zero for that field rather than throwing.

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
