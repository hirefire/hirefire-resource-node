## HireFire Integration Library for Node.js Applications

This library integrates Node.js applications with HireFire's Dyno Managers (Heroku Dyno Autoscalers). Instructions specific to supported web frameworks and worker libraries are provided during the setup process.

**Supported runtimes:** Node.js 22+

**Supported web frameworks:**

- Express 4+
- Koa 2+
- Connect 3+
- Fastify 4+
- Next.js 14+
- Sails
- Nest

**Supported worker libraries:**

- BullMQ 4+

The test suite runs against these minimum versions and the current latest release of each runtime and library. Older versions may still work, but are not officially supported.

---

Since 2011, over 1,500 companies have trusted [HireFire] to autoscale more than 5,000 applications hosted on [Heroku], managing over 10,000 web and worker dynos.

HireFire is distinguished by its support for both web and worker dynos, extending autoscaling capabilities to Standard-tier dynos. It provides fine-grained control over scaling behavior and improves scaling accuracy by monitoring more reliable metrics at the application level. These metrics include request queue time (web), job queue latency (worker), and job queue size (worker), which contribute to making more effective scaling decisions.

For more information, visit the [home page][HireFire].

---

## Development

Requires [Docker](https://www.docker.com/) — Redis for the BullMQ macro tests runs in a container. `bin/services up` starts it on a Docker-assigned free host port recorded in a git-ignored `.env` (read by the test suite); `bin/services down` stops it and removes `.env`.

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
