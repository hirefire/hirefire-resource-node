import hirefire from "hirefire-resource"
import * as namespace from "hirefire-resource"
import * as bullmq from "hirefire-resource/macro/bullmq"
import { jobQueueSize } from "hirefire-resource/macro/bullmq"
import express from "hirefire-resource/middleware/express"
import { middleware } from "hirefire-resource/middleware/next"
import Configuration from "hirefire-resource/configuration"
import { MissingQueueError } from "hirefire-resource/errors"
import pgBoss from "hirefire-resource/macro/pg-boss"
import { createRequire } from "module"

const require = createRequire(import.meta.url)
const required = require("hirefire-resource")
console.log(
  JSON.stringify({
    default_is_instance: typeof hirefire.configure,
    namespace_configure: typeof namespace.configure,
    namespace_default_configure: typeof namespace.default.configure,
    same_instance_as_require: hirefire === required,
    named_macro_import: typeof jobQueueSize,
    namespace_macro_names: Object.keys(bullmq).sort(),
    middleware_default: typeof express,
    next_named: typeof middleware,
    configuration_default: typeof Configuration,
    errors_named: typeof MissingQueueError,
    pg_boss_default: typeof pgBoss.jobQueueSize,
  }),
)
