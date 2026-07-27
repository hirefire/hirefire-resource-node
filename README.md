## HireFire Integration Library for Node.js Applications

This library integrates Node.js applications with HireFire's autoscalers. It pushes
request queue time, CPU, and job-queue metrics to `data.hirefire.io` (override with
`HIREFIRE_DATA_URL`). Setup steps for each web framework and worker library are shown
in the HireFire dashboard during install.

**Zero-config (common path):** set `HIREFIRE_TOKEN`, call `HireFire.boot()` (or
`HireFire.configure(() => {})`) early, and mount the framework middleware early in the
stack. There is no auto-insert and no auto-boot on `require`. Request queue time arms
from traffic and platform web-role hints. CPU is always-on when process identity
resolves (`HIREFIRE_SERVICE_NAME`, Heroku `DYNO`, or `RENDER_SERVICE_NAME`). Job queues
are driven by lease collection plans (BullMQ **size** / `jqs`) when `bullmq` is loadable,
or optional local `config.dyno("worker", sampler)` functions. There is no `service` or
`tracking` API. Lifecycle stop is `await HireFire.reset()` only (no public
`stopDispatcher`).

**Supported runtimes:**

- Node.js 22+

**Supported web frameworks:**

- Express 4+
- Koa 2+
- Connect 3+
- Fastify 4+
- Next.js 14+
- Sails 1+
- Nest 10+

**Supported worker libraries:**

- BullMQ 4+ (queue size only on lease plans. Latency is unsupported.)

The test suite runs against these minimum versions and the current latest release of each
runtime and library. Older versions may still work, but are not officially supported. The
package `engines` field allows Node `>=16` as a soft install floor.

**TypeScript:**

The package ships `.d.ts` declarations generated from its JSDoc. No separate `@types`
package is needed. The default import is the HireFire singleton. For typed catch of
configuration errors, import the `Configuration` class from the configuration subpath
(error classes are properties on it):

```js
const Configuration = require("hirefire-resource/configuration")
const { MissingSamplerError } = Configuration
```

For BullMQ, `JobQueueLatencyUnsupportedError` is exported from
`hirefire-resource/macro/bullmq`.

Optional local job-queue samplers:

```js
const HireFire = require("hirefire-resource")
const { jobQueueSize } = require("hirefire-resource/macro/bullmq")

HireFire.configure((config) => {
  config.dyno("worker", () => jobQueueSize("default"))
})
```

Optional explicit HTTP name (usually unnecessary on Heroku `web.*` / Fir web pods / Render
web services):

```js
HireFire.configure((config) => {
  config.dyno("web")
})
```

**Cluster / PM2:** start HireFire only in processes that serve HTTP traffic or should hold
the job-queue lease. Do not boot the library in an idle cluster primary that never handles
requests (it would claim empty web liveness under a non-web identity). Gate `boot` /
`configure` on worker role when using Node `cluster` or process managers with a master
process. Always `await HireFire.reset()` when reconfiguring or shutting down cleanly.

---

Since 2011, HireFire has helped over 1,500 companies autoscale more than 5,000 [Heroku]
applications across 10,000+ web and worker dynos.

HireFire autoscales both web and worker dynos, on all dyno tiers, using whichever signal
fits the workload: request queue time or requests per minute for web dynos, job queue
latency or job queue size for worker dynos, and CPU utilization for compute-bound web or
worker dynos. Each tracks real demand, so dynos are added when you need them and removed
when you don't. You pay only for what you use.

Learn more at the [home page][HireFire].

---

## Development

Requires [Docker](https://www.docker.com/) and [mise](https://mise.jdx.dev/). Redis for the
BullMQ macro tests runs in a container, and mise installs the pinned Node versions from
`.tool-versions`. `bin/services up` starts it on a Docker-assigned free host port recorded
in a git-ignored `.env` (read by the test suite). `bin/services down` stops it and removes
`.env`. Because the ports are assigned fresh at startup, multiple worktrees, and any
system-wide Redis, run side by side without conflicts.

- Run `bin/setup` to prepare the environment.
- Run `bin/services up` / `bin/services down` to start / stop the Redis container.
- See `npm run` for common tasks.

## Release

1. Update the version in `package.json` using
   `npm version <patch|minor|major> --no-git-tag-version`.
2. Ensure that `CHANGELOG.md` is up-to-date.
3. Commit changes with `git commit`.
4. Create a `git tag` matching the new version (e.g., `v1.0.0`).
5. Push the new git tag. Continuous Integration will handle the distribution process.

## License

This package is licensed under the terms of the MIT license.

[HireFire]: https://hirefire.io/
[Heroku]: https://heroku.com/
