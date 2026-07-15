## HireFire Integration Library for Node.js Applications

This library integrates Node.js applications with HireFire's Heroku Dyno Autoscalers. Instructions specific to supported web frameworks and worker libraries are provided during the setup process.

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

- BullMQ 4+

The test suite runs against these minimum versions and the current latest release of each runtime and library. Older versions may still work, but are not officially supported.

**TypeScript:**

The package ships `.d.ts` declarations generated from its JSDoc. No separate `@types` package is needed. The default import is the HireFire singleton. For typed catch of configuration errors, import the `Configuration` class from the configuration subpath (error classes are properties on it):

```js
const Configuration = require("hirefire-resource/configuration")
const { MissingSamplerError } = Configuration
```

For BullMQ, `JobQueueLatencyUnsupportedError` is exported from `hirefire-resource/macro/bullmq`.

---

Since 2011, HireFire has helped over 1,500 companies autoscale more than 5,000 [Heroku] applications across 10,000+ web and worker dynos.

HireFire autoscales both web and worker dynos, on all dyno tiers, using whichever signal fits the workload: request queue time or requests per minute for web dynos, job queue latency or job queue size for worker dynos, and CPU utilization for compute-bound web or worker dynos. Each tracks real demand, so dynos are added when you need them and removed when you don't. You pay only for what you use.

Learn more at the [home page][HireFire].

---

## Development

Requires [Docker](https://www.docker.com/). Redis for the BullMQ macro tests runs in a container. `bin/services up` starts it on a Docker-assigned free host port recorded in a git-ignored `.env` (read by the test suite). `bin/services down` stops it and removes `.env`.

- Run `bin/setup` to prepare the environment.
- Run `bin/services up` / `bin/services down` to start / stop the Redis container.
- See `npm run` for common tasks.

## Release

1. Update the version in `package.json` using `npm version <patch|minor|major> --no-git-tag-version`.
2. Ensure that `CHANGELOG.md` is up-to-date.
3. Commit changes with `git commit`.
4. Create a `git tag` matching the new version (e.g., `v1.0.0`).
5. Push the new git tag. Continuous Integration will handle the distribution process.

## License

This package is licensed under the terms of the MIT license.

[HireFire]: https://hirefire.io/
[Heroku]: https://heroku.com/
