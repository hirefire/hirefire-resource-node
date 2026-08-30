## HireFire Integration Library for Node.js Applications

This package integrates Node.js applications with HireFire's autoscalers on
Heroku. It reports app metrics so HireFire can scale web and worker processes
based on Request Queue Time, Requests Per Minute, CPU Activity, Job Queue Latency,
and Job Queue Size.

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

The package ships `.d.ts` declarations generated from its JSDoc.

**Documentation:**

The public API is documented with JSDoc. Changelog lives in [CHANGELOG.md](CHANGELOG.md).

---

Since 2011, HireFire has helped over 1,500 companies autoscale more than 5,000 [Heroku] applications across 10,000+ web and worker dynos.

HireFire autoscales web and worker processes based on the metrics that match the work: request queue time or requests per minute for web, job queue latency or job queue size for workers, and CPU activity for any compute-bound processes. Capacity follows demand, so you scale up when the app is busy and down when it is idle.

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
