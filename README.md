## HireFire Integration Library for Node.js Applications

This library integrates Node.js applications with HireFire's autoscalers on Heroku, Render, and other platforms.
It reports app metrics so HireFire can autoscale web and worker processes. That
unlocks strategies such as Request Queue Time, Requests Per Minute, CPU Activity,
Job Queue Latency, and Job Queue Size. Set `HIREFIRE_TOKEN` for the library to run.

**Supported runtimes:**

- Node.js 20+

**Supported web frameworks:**

- Express 4+
- Koa 2+
- Connect 3+
- Fastify 4+
- Next.js 14+ (Node runtime, not Edge)
- Sails 1+
- Nest 10+

**Supported worker libraries:**

- BullMQ 4+ (size only, no job queue latency). Sampling needs the `ioredis` package.
- Bull 4+ (classic OptimalBits/bull, size only, no job queue latency). Sampling needs the `ioredis` package.
- pg-boss 10 to 12 (job queue size and latency via read-only SQL). Versions 11 and 12 require Node 22+.

The test suite runs against these minimum versions and the current latest release of each runtime and library. Older versions may still work, but are not officially supported.

**Types:**

The package ships `.d.ts` declarations generated from its JSDoc. No separate `@types` package is needed.

**Documentation:**

Public API prose is JSDoc on the consumer-facing surface. Changelog lives in [CHANGELOG.md](CHANGELOG.md).

---

Since 2011, HireFire has helped over 1,500 companies autoscale more than 5,000 [Heroku] applications across 10,000+ web and worker dynos.

HireFire autoscales both web and worker processes, on every plan tier, using whichever signal fits the workload: request queue time or requests per minute for web processes, job queue latency or job queue size for worker processes, and CPU Activity for compute-bound processes. Each tracks real demand, so capacity is added when you need it and removed when you don't. You pay only for what you use.

Learn more at the [home page][HireFire].

---

## Development

Requires [Docker](https://www.docker.com/) and [mise](https://mise.jdx.dev/). Redis (BullMQ / classic Bull) and PostgreSQL (pg-boss) for the macro tests run in containers, and mise installs the pinned Node versions from `.tool-versions`. `bin/services up` starts them on Docker-assigned free host ports recorded in a git-ignored `.env` (read by the test suite). `bin/services down` stops them and removes `.env`. Because the ports are assigned fresh at startup, multiple worktrees can run side by side without conflicting with each other or with any system-wide databases.

- Run `bin/setup` to prepare the environment.
- Run `bin/services up` / `bin/services down` to start / stop Redis and Postgres.
- See `npm run` for common tasks (`npm run check`, `npm run format`, `npm test`, `npm run test:core`).

## Release

1. Update the version in `package.json` using
   `npm version <patch|minor|major> --no-git-tag-version` (prerelease:
   `npm version prerelease --preid=rc --no-git-tag-version`, e.g. `2.0.0-rc.1`).
2. If `package.json` dependencies changed, refresh `package-lock.json` with `npm install`.
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today's date) and add a fresh empty `## [Unreleased]` above it.
4. Commit changes with `git commit`.
5. Create a `git tag` matching the new version (e.g., `v2.0.0` or `v2.0.0-rc.1`).
6. Push the new git tag. Continuous Integration will handle the distribution process.
   Prerelease versions publish to the `rc` dist-tag, not `latest`.

## License

This package is licensed under the terms of the MIT license.

[HireFire]: https://hirefire.io/
[Heroku]: https://heroku.com/
