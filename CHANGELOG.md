# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `config.service(name, ...)` — a platform-neutral way to declare what a process tracks, for any platform (Heroku, Render, DigitalOcean, …). The name carries no meaning, so what to track is always explicit: `config.service("web", { tracking: "http" })` for request metrics, `config.service("worker", () => ...)` for job metrics (the function is the signal), `config.service("encoder", { tracking: "cpu" })` for CPU. Passing both a `tracking` option and a function, or neither, throws. `config.dyno` is now exactly `config.service` plus the Heroku Procfile convention that the `web` name implies `http`.
- `config.dyno` accepts an optional `{ tracking: "cpu" }` option — `config.dyno("web", { tracking: "cpu" })`, `config.dyno("encoder", { tracking: "cpu" })` — to report CPU under that dyno name. The name still implies request metrics for `web` and job metrics when a function is given, so the 1.x forms are unchanged. `"cpu"` is the only value `config.dyno` accepts; use `config.service(name, { tracking: "http" })` to declare an http process under a non-`web` name.
- CPUActivity metrics (the `cpu` collector): self-samples the dyno's CPU utilization once per second and pushes it in the per-second samples format. CPU time is read from a cgroup counter where one exists (cgroup v2/v1 — Heroku Fir, Render, Docker, K8s), else by summing `/proc/[pid]/stat` across the PID namespace (whole-dyno CPU on Heroku Cedar, which exposes no cpu cgroup), else `process.cpuUsage()` (dev/macOS). Normalized by the cgroup CPU quota where present, else the Cedar shared-dyno entitlement inferred from the dyno's memory limit (512 MB → 1 core, 1 GB → 2 cores), else the processor count. Gated by process identity (`HIREFIRE_SERVICE_NAME`, the Heroku `DYNO` name — both Cedar `web.1` and Fir pod-name formats — or `RENDER_SERVICE_NAME`) so a process only reports CPU under its own dyno name; unresolved identity disables CPU with a loud log rather than throwing.
- Web liveness claims (heartbeats and backfilled empty seconds) are gated by process identity: when the process's identity resolves and does not match the declared web dyno name, only real request samples are delivered and no liveness is synthesized. This prevents idle worker, one-off, and console processes from claiming web seconds. When identity cannot be resolved, behavior is unchanged.
- Web metrics now claim every second between dispatches: seconds with no buffered samples are backfilled with explicit empty arrays (capped at 60 seconds, advancing only on successful delivery), so the server receives a complete per-second record — "alive with zero traffic" is reported as zero rather than left as a gap. Required for the RequestsPerMinute autoscaling strategy.
- Workers are deduplicated fleet-wide via a server lease (`POST /metrics/lease`): only the granted process samples job metrics, so a scaled-out worker fleet reports one set of values. Lease TTL and sample frequency are server-controlled via response headers.
- A 1-second dispatcher loop drains the buffer and pushes via `POST /metrics/ingest`. Each tick stage (lease renewal, job sampling, each CPU collector) is individually isolated so a failing stage can't starve dispatch. A raising sampler is logged and costs one sample window; non-numeric, negative, or non-finite sampler return values are dropped with a logged error.
- Declaring a second http process now throws, under any name and across both `config.dyno` and `config.service` (request metrics come from this process's own http traffic, so only one http collector can exist per process). Duplicate-name detection spans both methods and is case-insensitive.
- `X-Request-Start` parsing now handles the nginx (`t=` + epoch seconds) and Apache (`t=` + epoch microseconds) formats in addition to Heroku's epoch milliseconds, and ignores unparseable or implausible values.
- Timestamped buffers are bounded: when dispatch is starved (network outage), web/CPU seconds older than the 60-second server acceptance window are pruned at insert time, and worker samples keep only the latest value per name. A buffered payload that would exceed the server's 64 KB body limit is dropped (resuming from the current second) rather than retried forever.
- All transport errors (DNS, refused/reset connections, TLS, timeouts) are mapped to a single `RequestError` and handled uniformly. A `401` (no enabled autoscaler / invalid token) is silently discarded.

### Changed

- The library no longer serves the `/hirefire/<token>/info` endpoint; worker metrics are pushed instead. The backend keeps the legacy pull path for pre-1.3.0 agents, so the transition is resolved server-side with no config change.
- Removed the `async-mutex` runtime dependency — the library now has **zero runtime dependencies**. Buffer access is synchronous on Node's single-threaded event loop, so no lock is needed.
- `HIREFIRE_DISPATCH_URL` (the 1.x web logdrain override) is removed; the push base URL is `HIREFIRE_DATA_URL` (default `https://data.hirefire.io`). Restricted-egress networks must allowlist `data.hirefire.io` (outbound) or metrics silently stop.
- Widened the supported Node range to `>=16`.

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
