# Node Agent (Autoscale.app)

Provides [Autoscale.app] with the necessary metrics for autoscaling web and worker processes.

## Installation

Add the package to your `package.json`:

    npm install @autoscale/agent@^0

## Usage

This package may be used as a stand-alone agent, or as middleware that integrates with [Express], [Koa] or any Express/Koa-based frameworks, or frameworks with a Express/Koa-compatible middleware interface.

Installation instructions are provided during the autoscaler setup process on [Autoscale.app].

## Related Packages

The following packages are currently available.

#### Agents (Web Framework Middleware)

| Web Framework | Repository                                          |
|---------------|-----------------------------------------------------|
| Express       | https://github.com/autoscale-app/node-agent-express |
| Koa           | https://github.com/autoscale-app/node-agent-koa     |

#### Queues (Worker Metric Functions)

| Worker Library | Repository                                         |
|----------------|----------------------------------------------------|
| BullMQ         | https://github.com/autoscale-app/node-queue-bullmq |

Let us know if your preferred web framework or worker library isn't available and we'll see if we can add support.

## Development

Prepare environment:

    npm install

See npm for relevant tasks:

    npm run

## Release

1. Update `CHANGELOG.md`
2. Run `npm version major | minor | patch`
3. Push the new tag

## Contributing

Bug reports and pull requests are welcome on GitHub at https://github.com/autoscale-app/node-agent

[Autoscale.app]: https://autoscale.app
[BullMQ]: https://github.com/taskforcesh/bullmq
[Express]: https://expressjs.com
[Koa]: https://koajs.com
