"use strict"

const { threadId } = require("worker_threads")
const HireFire = require("hirefire-resource")

HireFire.boot()
console.log(
  `[host] pid=${
    process.pid
  } thread=${threadId} running=${HireFire.configuration.dispatcher.running()}`,
)

const app = require("express")()
app.use(require("hirefire-resource/middleware/express"))
app.get("/", (req, res) => res.send("ok"))
app.listen(Number(process.env.PORT))
