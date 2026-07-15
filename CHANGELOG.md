# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- JSDoc on `RequestError`, the collector `sample` methods (`Web`, `Worker`, `Workers`, `CPU`), and a fuller `Dispatcher` class summary, matching the Ruby YARD coverage those symbols already had.
- TypeScript type declarations (`.d.ts`) ship with the package, so editors and TypeScript projects get autocomplete and type-checking for the public API without a separate `@types` install. The library itself stays plain JavaScript: the declarations are generated from its JSDoc. Overloaded APIs (`service`, `dyno`, `jobQueueSize`) carry their full descriptions, throws, and examples in the shipped declarations. The public `Configuration` surface is typed accurately (`web` nullable, `cpu` as `CPU[]`, documented fields and getters, typed error constructors), and `config.logger` is a duck-typed `Logger | null` (optional `error` / `warn` / `info` methods) rather than the full Node `Console` type, so custom loggers type-check under strict TypeScript.
- `hirefire-resource/configuration` package subpath exports the `Configuration` class and its error classes (`MissingSamplerError`, `UnexpectedSamplerError`, `UnknownCollectorError`, `DuplicateDynoError`) for typed catch clauses, without changing the default singleton export.
- `hirefire-resource/macro/bullmq` exports `JobQueueLatencyUnsupportedError`, so TypeScript consumers can import it alongside `jobQueueLatency` for typed `instanceof` checks.
- `config.service(name, ...)`: a way to declare what a process tracks. The name carries no meaning, so what to track is always explicit: `config.service("web", { tracking: "http" })` for request metrics, `config.service("worker", () => ...)` for job metrics (the function is the signal), `config.service("encoder", { tracking: "cpu" })` for CPU. Passing both a `tracking` option and a function, or neither, throws. `config.dyno` is now exactly `config.service` plus the Procfile convention that the `web` name implies `http`.
- `config.dyno` accepts an optional `{ tracking: "cpu" }` option (`config.dyno("web", { tracking: "cpu" })`, `config.dyno("encoder", { tracking: "cpu" })`) to report CPU under that dyno name. The name still implies request metrics for `web` and job metrics when a function is given, so the 1.x forms are unchanged. `"cpu"` is the only value `config.dyno` accepts. Use `config.service(name, { tracking: "http" })` to declare an http process under a non-`web` name.
- CPUActivity metrics (the `cpu` collector): self-samples the dyno's CPU utilization once per second and pushes it in the per-second samples format. CPU time is read from a cgroup counter where one exists (cgroup v2/v1), else by summing `/proc/[pid]/stat` across the PID namespace (whole-dyno CPU where no cpu cgroup is exposed), else `process.cpuUsage()` (dev/macOS). Normalized by the cgroup CPU quota where present, else the Cedar shared-dyno entitlement inferred from the dyno's memory limit (512 MB → 1 core, 1 GB → 2 cores), else the processor count. Gated by process identity (`HIREFIRE_SERVICE_NAME`, the Heroku `DYNO` name (both Cedar `web.1` and Fir pod-name formats), or `RENDER_SERVICE_NAME`) so a process only reports CPU under its own dyno name. Unresolved identity disables CPU with a loud log rather than throwing.
- Web liveness claims (heartbeats and backfilled empty seconds) are gated by process identity: when the process's identity resolves and does not match the declared web dyno name, only real request samples are delivered and no liveness is synthesized. This prevents idle worker, one-off, and console processes from claiming web seconds. When identity cannot be resolved, behavior is unchanged.
- Web metrics now claim every second between dispatches: seconds with no buffered samples are backfilled with explicit empty arrays (capped at 60 seconds, advancing only on successful delivery), so the server receives a complete per-second record. "Alive with zero traffic" is reported as zero rather than left as a gap. Required for the RequestsPerMinute autoscaling strategy.
- Workers are deduplicated fleet-wide via a server lease (`POST /metrics/lease`): only the granted process samples job metrics, so a scaled-out worker fleet reports one set of values. Lease TTL and sample frequency are server-controlled via response headers.
- The dispatcher runs web/CPU dispatch and worker sampling on separate 1-second loops, so a slow or hung worker sampler (a job backend blocking with no timeout) can no longer stall metric delivery. A hung sampler stops renewing its lease, so the server hands worker sampling to a healthy process. Within each loop, stages stay isolated: a raising sampler is logged and costs one sample window, and a failed lease renewal is logged, revokes the local grant, and waits a full TTL before retrying. Non-numeric, negative, or non-finite sampler return values are dropped with a logged error.
- The middleware is crash-safe: the per-request bookkeeping is wrapped so an internal failure is logged and swallowed instead of raising into the host application's request. The downstream app call stays outside the guard, so the host app's own exceptions still propagate.
- Metric dispatch and lease requests reuse a persistent HTTPS connection (keep-alive) via a dedicated per-client agent rather than Node's shared global agent, instead of a fresh TCP and TLS handshake per request. On the roughly once-per-second dispatch path this removes most per-request round-trips and the handshake CPU spent on the host process. A keep-alive socket the peer closes while idle is transparently reconnected and retried once (both endpoints are idempotent, so the retry is safe).
- Declaring a second http process now throws, under any name and across both `config.dyno` and `config.service` (request metrics come from this process's own http traffic, so only one http collector can exist per process). Duplicate-name detection spans both methods and is case-insensitive.
- `X-Request-Start` parsing now handles the nginx (`t=` + epoch seconds) and Apache (`t=` + epoch microseconds) formats in addition to Heroku's epoch milliseconds, and ignores unparseable or implausible values.
- Timestamped buffers are bounded: when dispatch is starved (network outage), web/CPU seconds older than the 60-second server acceptance window are pruned at insert time, and worker samples keep only the latest value per name. A buffered payload that would exceed the server's 64 KB body limit is dropped (resuming from the current second) rather than retried forever.
- All transport errors (DNS, refused/reset connections, TLS, timeouts) are mapped to a single `RequestError` and handled uniformly. A `401` (no enabled autoscaler / invalid token) is silently discarded.

### Changed

- The library no longer serves the `/hirefire/<token>/info` endpoint. Worker metrics are pushed instead. The backend keeps the legacy pull path for pre-1.3.0 agents, so the transition is resolved server-side with no config change.
- Removed the `async-mutex` runtime dependency. The library now has **zero runtime dependencies**. Buffer access is synchronous on Node's single-threaded event loop, so no lock is needed.
- `HIREFIRE_DISPATCH_URL` (the 1.x web logdrain override) is removed. The push base URL is `HIREFIRE_DATA_URL` (default `https://data.hirefire.io`). Restricted-egress networks must allowlist `data.hirefire.io` (outbound) or metrics silently stop.
- Widened the supported Node range to `>=16`.

### Fixed

- `jobQueueSize` always returns a JavaScript `number`, including when IORedis is configured with `stringNumbers: true` (which would otherwise yield string counts that job samplers drop).
- Internal dispatch pacing, lease renewal, and the CPU utilization delta now measure elapsed time on a monotonic clock, so a system clock adjustment (e.g. an NTP step) no longer skews the dispatch cadence, lease renewal, or a CPU reading. The metric timestamps themselves stay wall-clock, as the server requires.
- A reused keep-alive socket that reads back a garbled response (an `HPE_*` HTTP-parser error) is now reconnected and retried once, like a reset socket, matching the Ruby and Python clients.

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
