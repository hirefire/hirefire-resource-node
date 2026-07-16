require("./support")
const Configuration = require("../src/configuration")
const Identity = require("../src/identity")
const Web = require("../src/web")
const CPU = require("../src/cpu")
const Dispatcher = require("../src/dispatcher")
const Buffer = require("../src/buffer")

describe("Configuration", () => {
  let config

  beforeEach(() => {
    config = new Configuration()
    config.logger = { info() {}, warn() {}, error() {} }
  })

  test("default logger points to console", () => {
    expect(new Configuration().logger).toBe(console)
  })

  test("can set the logger", () => {
    const custom = { info() {} }
    config.logger = custom
    expect(config.logger).toBe(custom)
  })

  test("web defaults to null", () => {
    expect(config.web).toBeNull()
  })

  test("workers default to empty", () => {
    expect(config.workers.any()).toBe(false)
  })

  test("cpu defaults to empty", () => {
    expect(config.cpu).toEqual([])
  })

  test("dyno web configures http", () => {
    config.dyno("web")
    expect(config.web).toBeInstanceOf(Web)
    expect(config.web.name).toBe("web")
  })

  test("dyno web is case-insensitive for http", () => {
    config.dyno("Web")
    expect(config.web).toBeInstanceOf(Web)
    expect(config.web.name).toBe("Web")
  })

  test("dyno with a function configures a worker", async () => {
    config.dyno("worker", () => 1.23)
    config.dyno("mailer", () => 2.46)
    const workers = [...config.workers]
    expect(workers.map((w) => w.name)).toEqual(["worker", "mailer"])
    expect(await workers[0].sample()).toBe(1.23)
    expect(await workers[1].sample()).toBe(2.46)
  })

  test("dyno web with cpu configures cpu", () => {
    config.dyno("web", { tracking: "cpu" })
    expect(config.web).toBeNull()
    expect(config.cpu.map((c) => c.name)).toEqual(["web"])
  })

  test("dyno non-web with cpu configures cpu", () => {
    config.dyno("clock", { tracking: "cpu" })
    expect(config.cpu.length).toBe(1)
    expect(config.cpu[0]).toBeInstanceOf(CPU)
    expect(config.cpu[0].name).toBe("clock")
  })

  test("dyno without function or tracking raises for a non-web name", () => {
    expect(() => config.dyno("worker")).toThrow(
      Configuration.MissingSamplerError,
    )
  })

  test("dyno treats tracking null like not given", () => {
    config.dyno("web", { tracking: null })
    expect(config.web).toBeInstanceOf(Web)
    expect(config.web.name).toBe("web")
  })

  test("dyno with tracking null and a sampler configures a worker", async () => {
    config.dyno("worker", { tracking: null }, () => 1.23)
    const workers = [...config.workers]
    expect(workers.length).toBe(1)
    expect(await workers[0].sample()).toBe(1.23)
  })

  test("dyno rejects http-family acronyms", () => {
    expect(() => config.dyno("web", { tracking: "rqt" })).toThrow(
      Configuration.UnknownCollectorError,
    )
  })

  test("dyno rejects the http keyword", () => {
    expect(() => config.dyno("web", { tracking: "http" })).toThrow(
      Configuration.UnknownCollectorError,
    )
  })

  test("dyno rejects job-family acronyms", () => {
    expect(() => config.dyno("worker", { tracking: "jql" })).toThrow(
      Configuration.UnknownCollectorError,
    )
  })

  test("dyno cpu rejects a sampler", () => {
    expect(() => config.dyno("web", { tracking: "cpu" }, () => 1)).toThrow(
      Configuration.UnexpectedSamplerError,
    )
  })

  test("service http configures http", () => {
    config.service("web", { tracking: "http" })
    expect(config.web).toBeInstanceOf(Web)
    expect(config.web.name).toBe("web")
  })

  test("service http allows a non-web name", () => {
    config.service("api", { tracking: "http" })
    expect(config.web.name).toBe("api")
  })

  test("service with a function configures a worker", async () => {
    config.service("worker", () => 1.23)
    const workers = [...config.workers]
    expect(workers.length).toBe(1)
    expect(workers[0].name).toBe("worker")
    expect(await workers[0].sample()).toBe(1.23)
  })

  test("service cpu configures cpu", () => {
    config.service("clock", { tracking: "cpu" })
    expect(config.cpu.map((c) => c.name)).toEqual(["clock"])
  })

  test("service with tracking and a function raises", () => {
    expect(() => config.service("web", { tracking: "http" }, () => 1)).toThrow(
      Configuration.UnexpectedSamplerError,
    )
  })

  test("service cpu with a function raises", () => {
    expect(() => config.service("clock", { tracking: "cpu" }, () => 1)).toThrow(
      Configuration.UnexpectedSamplerError,
    )
  })

  test("service without tracking or a function raises", () => {
    expect(() => config.service("worker")).toThrow(
      Configuration.MissingSamplerError,
    )
  })

  test("service treats tracking null like not given", () => {
    expect(() => config.service("worker", { tracking: null })).toThrow(
      Configuration.MissingSamplerError,
    )
  })

  test("service with tracking null and a sampler configures a worker", async () => {
    config.service("worker", { tracking: null }, () => 1.23)
    const workers = [...config.workers]
    expect(workers.length).toBe(1)
    expect(await workers[0].sample()).toBe(1.23)
  })

  test("service rejects an unknown keyword", () => {
    expect(() => config.service("web", { tracking: "foo" })).toThrow(
      Configuration.UnknownCollectorError,
    )
  })

  test("empty name raises", () => {
    expect(() => config.dyno(null, { tracking: "cpu" })).toThrow()
    expect(() => config.dyno("", { tracking: "cpu" })).toThrow()
    expect(() => config.service(null, { tracking: "http" })).toThrow()
    expect(() => config.service("", { tracking: "http" })).toThrow()
  })

  test("duplicate name raises", () => {
    config.dyno("web")
    expect(() => config.dyno("web", { tracking: "cpu" })).toThrow(
      Configuration.DuplicateDynoError,
    )
  })

  test("duplicate name guard spans dyno and service case-insensitively", () => {
    config.dyno("web")
    expect(() => config.service("Web", { tracking: "http" })).toThrow(/Web/)
  })

  test("a second http declaration under a different name raises", () => {
    config.dyno("web")
    expect(() => config.service("api", { tracking: "http" })).toThrow(/web/)
  })

  test("dyno and service share the one-http guard", () => {
    config.service("api", { tracking: "http" })
    expect(() => config.dyno("web")).toThrow(Configuration.DuplicateDynoError)
  })

  test("dyno and service register into the same collectors", () => {
    config.dyno("web")
    config.service("worker", () => 1)
    process.env.HIREFIRE_SERVICE_NAME = "clock"
    config.service("clock", { tracking: "cpu" })

    expect(config.web.name).toBe("web")
    expect(config.workers.map((w) => w.name)).toEqual(["worker"])
    expect(config.cpu.map((c) => c.name)).toEqual(["clock"])
  })

  test("rejects a positional second argument (dyno)", () => {
    expect(() => config.dyno("web", "cpu")).toThrow()
  })

  test("rejects a positional second argument (service)", () => {
    expect(() => config.service("web", "http")).toThrow()
  })

  test("a rejected registration does not reserve the name", () => {
    expect(() => config.service("web", { tracking: "http" }, () => 1)).toThrow(
      Configuration.UnexpectedSamplerError,
    )
    expect(() => config.service("web", { tracking: "http" })).not.toThrow()
    expect(config.web.name).toBe("web")
  })

  test("dispatcher returns an instance", () => {
    expect(config.dispatcher).toBeInstanceOf(Dispatcher)
  })

  test("dispatcher is memoized", () => {
    expect(config.dispatcher).toBe(config.dispatcher)
  })

  test("dispatcher receives web", () => {
    config.dyno("web")
    expect(config.dispatcher._web).toBe(config.web)
  })

  test("dispatcher receives workers", () => {
    config.dyno("worker", () => 1)
    expect(config.dispatcher._workers).toBe(config.workers)
  })

  test("dispatcher without web", () => {
    expect(config.dispatcher._web).toBeNull()
  })

  test("buffer returns an instance", () => {
    expect(config.buffer).toBeInstanceOf(Buffer)
  })

  test("buffer is memoized", () => {
    expect(config.buffer).toBe(config.buffer)
  })

  test("cpu collector active when identity matches", () => {
    process.env.HIREFIRE_SERVICE_NAME = "clock"
    config.dyno("clock", { tracking: "cpu" })
    expect(config.dispatcher._cpu.map((c) => c.name)).toEqual(["clock"])
  })

  test("cpu collector dormant when identity differs", () => {
    process.env.DYNO = "web.1"
    config.dyno("clock", { tracking: "cpu" })
    expect(config.dispatcher._cpu).toEqual([])
  })

  test("cpu collector disabled and logged when identity unresolved", () => {
    config.logger.error = jest.fn()
    config.dyno("clock", { tracking: "cpu" })
    expect(config.dispatcher._cpu).toEqual([])
    expect(config.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("HIREFIRE_SERVICE_NAME"),
    )
  })

  test("identity resolution skipped with only job collectors", () => {
    process.env.DYNO = "web.1"
    const resolve = jest.spyOn(Identity, "resolve")
    config.dyno("worker", () => 1)
    config.dispatcher
    expect(resolve).not.toHaveBeenCalled()
  })

  test("web liveness allowed when identity matches", () => {
    process.env.DYNO = "web.1"
    config.dyno("web")
    expect(config.dispatcher._webLiveness).toBe(true)
  })

  test("web liveness allowed when identity unresolved", () => {
    config.dyno("web")
    expect(config.dispatcher._webLiveness).toBe(true)
  })

  test("web liveness denied when identity differs", () => {
    process.env.DYNO = "worker.1"
    config.dyno("web")
    expect(config.dispatcher._webLiveness).toBe(false)
  })

  test("web liveness matches non-web http names", () => {
    process.env.RENDER_SERVICE_NAME = "api"
    config.service("api", { tracking: "http" })
    expect(config.dispatcher._webLiveness).toBe(true)
  })

  test("web liveness matches case-insensitively", () => {
    process.env.DYNO = "Web.1"
    config.dyno("web")
    expect(config.dispatcher._webLiveness).toBe(true)
  })

  test("web liveness is true without a web collector", () => {
    process.env.HIREFIRE_SERVICE_NAME = "clock"
    config.dyno("clock", { tracking: "cpu" })
    expect(config.dispatcher._webLiveness).toBe(true)
  })

  test("cpu collector matches case-insensitively", () => {
    process.env.DYNO = "Worker.1"
    config.dyno("worker", { tracking: "cpu" })
    expect(config.dispatcher._cpu.map((c) => c.name)).toEqual(["worker"])
  })

  test("heroku config var conflict is warned", () => {
    process.env.DYNO = "worker.1"
    process.env.HIREFIRE_SERVICE_NAME = "web"
    config.logger.warn = jest.fn()
    config.dyno("worker", { tracking: "cpu" })
    config.dispatcher
    expect(config.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("app-wide"),
    )
  })

  test("heroku config var conflict warned only once", () => {
    process.env.DYNO = "worker.1"
    process.env.HIREFIRE_SERVICE_NAME = "web"
    config.logger.warn = jest.fn()
    config.dyno("web")
    config.dyno("clock", { tracking: "cpu" })
    config.dispatcher
    expect(config.logger.warn).toHaveBeenCalledTimes(1)
  })

  test("logQueueMetrics defaults to false", () => {
    expect(config.logQueueMetrics).toBe(false)
  })

  test("logQueueMetrics can be set", () => {
    config.logQueueMetrics = true
    expect(config.logQueueMetrics).toBe(true)
  })

  test("token defaults to env", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    expect(config.token).toBe("from-env")
  })

  test("token can be overridden", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    config.token = "custom-token"
    expect(config.token).toBe("custom-token")
  })

  test("token defaults to null without env", () => {
    expect(config.token).toBeNull()
  })

  test("token empty string is treated as absent", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    config.token = ""
    expect(config.token).toBeNull()
  })

  test("token empty env is treated as absent", () => {
    process.env.HIREFIRE_TOKEN = ""
    expect(config.token).toBeNull()
  })

  test("token null falls back to env", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    config.token = "custom-token"
    config.token = null
    expect(config.token).toBe("from-env")
  })
})
