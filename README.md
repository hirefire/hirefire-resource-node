## HireFire: Advanced Autoscaling for Heroku-hosted Applications

[HireFire] is the oldest and a leading autoscaling service for applications hosted on [Heroku]. Since 2011, we've assisted more than 1,000 companies in autoscaling upwards of 5,000 applications, involving over 10,000 dynos.

This gem streamlines the integration of HireFire with Node applications running on Heroku, offering companies substantial cost savings while maintaining optimal performance.

---

### Supported Node Versions:

|     | Node |
| --- | ---- |
| ✅  | 16   |
| ✅  | 17   |
| ✅  | 18   |
| ✅  | 19   |

---

### Supported Node Web Frameworks:

HireFire comes with the following middleware integration:

|     | Node Middleware |
| --- | --------------- |
| ✅  | Express         |
| ✅  | Connect         |
| ✅  | Koa             |

This makes it compatible with a broad range of Node web frameworks, as many of them are built on top of Express, Connect or Koa.

---

### Supported Node Worker Libraries:

Some libraries lack the requisite structure to measure latency. If your preferred library isn't listed, or if you need further support, please contact us.

| Node Worker Library | Job Queue Latency | Job Queue Size |
| ------------------- | :---------------: | :------------: |
| BullMQ              |        ❌         |       ✅       |

---

### Integration Demonstration

To easily integrate HireFire with an existing Node application (i.e. Express and BullMQ):

1. Install the Node package:

```js
npm install hirefire-resource
```

2. Configure HireFire in your application and add the middleware:

```js
const express = require("express")
const HireFire = require("hirefire-resource")
const HireFireMiddlewareExpress = require("hirefire-resource/middleware/express")
const HireFireMacroBullMQ = require("hirefire-resource/macro/bullmq")

HireFire.configure((config) => {
  // To collect Request Queue Time metrics for autoscaling `web` dynos:
  config.dyno("web")
  // To collect Job Queue Size metrics for autoscaling `worker` dynos:
  config.dyno("worker", async () => HireFireMacroBullMQ.jobQueueSize("default"))
})

const app = express()
// To add the middleware to collect the web and worker metrics:
app.use(HireFireMiddlewareExpress)
```

After completing these steps, deploy your application to Heroku. Then, [sign into HireFire] to complete your autoscaling setup by adding the web and worker dyno managers.

---

## Development

### Setup

Run `bin/setup` to prepare the environment by installing dependencies.

### Tasks

Use `npm run <script>` to perform common tasks (i.e. format, test). See scripts in `package.json`.

### Installation

Install this package on your local machine using `npm link`.

### Releases

1. Bump the `package.json` version using `npm version <patch|minor|major>`.
2. Update `CHANGELOG.md` for the bumped version.
3. Commit your changes with `git commit`.
4. Create a new git tag matching the bumped version (e.g., `v1.0.0`) with `git tag`.
5. Push the new tag. GitHub Actions will handle the release process from there.

---

### Questions?

Feel free to [contact us] for support and inquiries.

---

### License

`hirefire-resource` is licensed under the MIT license. See LICENSE.

[HireFire]: https://www.hirefire.io/
[Heroku]: https://www.heroku.com/
[sign into HireFire]: https://manager.hirefire.io/login
[contact us]: mailto:support@hirefire.io
