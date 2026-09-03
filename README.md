## HireFire Integration Library for Node.js Applications

This package integrates Node.js applications running on [Heroku] with [HireFire]'s autoscalers. It collects HTTP, CPU, and job metrics so HireFire can scale web and worker processes based on Request Queue Time, Requests Per Minute, CPU Activity, Job Queue Latency, and Job Queue Size.

**Supported runtimes:**

- Node.js 20+

**Supported web frameworks:**

- Express 4+
- Koa 2+
- Connect 3+
- Fastify 4+
- Next.js 14+ (unit-tested). Node.js middleware runtime requires 15.5+ (not Edge). Next.js 16 uses `proxy.ts`.
- Sails 1+
- Nest 10+

**Supported worker libraries:**

- BullMQ 4+ (size only, no job queue latency, needs the `ioredis` package)
- Bull 4+ (classic OptimalBits/bull, size only, no job queue latency, needs the `ioredis` package)
- pg-boss 10 to 12 (job queue size and latency via read-only SQL, versions 11 and 12 require Node.js 22+, needs the `pg` package)

The test suite runs against these minimum versions and the current latest release of each runtime and library. Older versions may still work, but are not officially supported.

**Types:**

The package ships `.d.ts` declarations for TypeScript consumers. Native ESM named imports of macros (for example `import { jobQueueSize } from "hirefire-resource/macro/bull"`) can type-check and fail at runtime. Use the default import under ESM.

**Documentation:**

Changelog lives in [CHANGELOG.md](CHANGELOG.md). Setup instructions for supported web frameworks and worker libraries are provided in the HireFire UI during installation.

Next.js middleware (15.5+ Node runtime) should skip static assets:

```js
export const config = {
  matcher: "/((?!_next/static|_next/image|favicon.ico).*)",
  runtime: "nodejs",
};
```

## Development

Requires [Docker](https://www.docker.com/), [mise](https://mise.jdx.dev/), and `jq` (matrix scripts). Redis (BullMQ / classic Bull) and PostgreSQL (pg-boss) for the macro tests run in containers, and mise installs the pinned Node.js versions from `.tool-versions`. `bin/services up` starts them on Docker-assigned free host ports recorded in a git-ignored `.env` (read by the test suite). `bin/services down` stops them and removes `.env`. Because the ports are assigned fresh at startup, multiple worktrees can run side by side without conflicting with each other or with any system-wide databases.

- Run `bin/setup` to prepare the environment.
- Run `bin/services up` / `bin/services down` to start / stop Redis and PostgreSQL.
- See `npm run` for common tasks (`npm run check`, `npm run format`, `npm test`, `npm run test:core`).

## Release

1. Update the version in `package.json` using `npm version <patch|minor|major> --no-git-tag-version`. For the first release candidate of a version, set it explicitly (for example `npm version 2.0.0-rc.1 --no-git-tag-version`). `npm version prerelease --preid=rc` from `2.0.0` yields `2.0.1-rc.0`, not `2.0.0-rc.1`.
2. If `package.json` dependencies changed, refresh `package-lock.json` with `npm install`.
3. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD` (today's date) and add a fresh empty `## [Unreleased]` above it.
4. Commit changes with `git commit`.
5. On `master`, create a `git tag` matching the new version (e.g., `v2.0.0` or `v2.0.0-rc.1`). The publish job requires the tag to point at `origin/master`.
6. Push the new git tag. Continuous Integration will handle the distribution process. Prerelease versions publish to the `rc` dist-tag, not `latest`.

## License

This package is licensed under the terms of the MIT license.

[HireFire]: https://hirefire.io/
[Heroku]: https://heroku.com/
