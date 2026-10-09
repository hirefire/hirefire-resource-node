"use strict"

const cluster = require("cluster")
const http = require("http")

const kind = process.env.HOST_KIND
const clustered = process.env.HOST_CLUSTER === "1"
const port = Number(process.env.PORT)
const HireFire = require("hirefire-resource")

HireFire.configure((config) => {
  if (process.env.HOST_SAMPLER === "1") config.dyno("worker", () => 3)
})
console.log(
  `[host] pid=${process.pid} role=${
    cluster.isPrimary ? "primary" : "worker"
  } running=${HireFire.configuration.dispatcher.running()}`,
)

function listen() {
  if (kind === "http") {
    const middleware = require("hirefire-resource/middleware/connect")
    http
      .createServer((req, res) => middleware(req, res, () => res.end("ok")))
      .listen(port)
  } else if (kind === "connect") {
    const app = require("connect")()
    app.use(require("hirefire-resource/middleware/connect"))
    app.use((req, res) => res.end("ok"))
    http.createServer(app).listen(port)
  } else if (kind === "express") {
    const app = require("express")()
    app.use(require("hirefire-resource/middleware/express"))
    app.get("/", (req, res) => res.send("ok"))
    app.listen(port)
  } else if (kind === "koa") {
    const Koa = require("koa")
    const app = new Koa()
    app.use(require("hirefire-resource/middleware/koa"))
    app.use((ctx) => {
      ctx.body = "ok"
    })
    app.listen(port)
  } else if (kind === "fastify") {
    const app = require("fastify")()
    app.register(require("hirefire-resource/middleware/fastify"))
    app.get("/", async () => "ok")
    app.listen({ port, host: "0.0.0.0" })
  }
}

if (clustered && cluster.isPrimary) {
  cluster.fork()
  cluster.fork()
} else if (kind !== "none") {
  listen()
}
