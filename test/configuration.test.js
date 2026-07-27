require("./support")
const Configuration = require("../src/configuration")
const Web = require("../src/web")
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

  test("http defaults to null", () => {
    expect(config.http).toBeNull()
    expect(config.web).toBeNull()
  })

  test("workers default to empty", () => {
    expect(config.workers.any()).toBe(false)
  })

  test("dyno web configures http", () => {
    config.dyno("web")
    expect(config.http).toBeInstanceOf(Web)
    expect(config.http.name).toBe("web")
  })

  test("dyno web is case-insensitive for http", () => {
    config.dyno("Web")
    expect(config.http).toBeInstanceOf(Web)
    expect(config.http.name).toBe("Web")
  })

  test("dyno with a function configures a worker", async () => {
    config.dyno("worker", () => 1.23)
    config.dyno("mailer", () => 2.46)
    const workers = [...config.workers]
    expect(workers.map((w) => w.name)).toEqual(["worker", "mailer"])
    expect(await workers[0].sample()).toBe(1.23)
    expect(await workers[1].sample()).toBe(2.46)
  })

  test("dyno without function raises for a non-web name", () => {
    expect(() => config.dyno("worker")).toThrow(
      Configuration.MissingSamplerError,
    )
  })

  test("dyno rejects non-function second arg", () => {
    expect(() => config.dyno("worker", { tracking: "cpu" })).toThrow(TypeError)
    expect(() => config.dyno("web", "nope")).toThrow(TypeError)
    expect(() => config.dyno("worker", {})).toThrow(TypeError)
  })

  test("dyno rejects more than two arguments", () => {
    expect(() => config.dyno("worker", () => 1, true)).toThrow(TypeError)
  })

  test("empty name raises", () => {
    expect(() => config.dyno(null)).toThrow(TypeError)
    expect(() => config.dyno("")).toThrow(TypeError)
    expect(() => config.dyno("   ")).toThrow(TypeError)
  })

  test("dyno strips name whitespace", () => {
    config.dyno("  worker  ", () => 1)
    expect(config.workers.findByName("worker").name).toBe("worker")
  })

  test("dyno rejects name over max bytes", () => {
    const tooLong = "w".repeat(129)
    expect(() => config.dyno(tooLong, () => 1)).toThrow(/128/)
  })

  test("duplicate same kind raises", () => {
    config.dyno("web")
    expect(() => config.dyno("web")).toThrow(Configuration.DuplicateDynoError)
  })

  test("duplicate name guard is case insensitive", () => {
    config.dyno("web")
    expect(() => config.dyno("Web")).toThrow(Configuration.DuplicateDynoError)
  })

  test("same name may declare http and job queue", () => {
    config.dyno("web")
    config.dyno("web", () => 1)
    expect(config.http.name).toBe("web")
    expect([...config.workers].map((w) => w.name)).toEqual(["web"])
  })

  test("first seen casing is preserved across kinds", () => {
    config.dyno("Web")
    config.dyno("web", () => 1)
    expect(config.http.name).toBe("Web")
    expect([...config.workers][0].name).toBe("Web")
  })

  test("rejected registration does not reserve name", () => {
    expect(() => config.dyno("worker")).toThrow(
      Configuration.MissingSamplerError,
    )
    config.dyno("worker", () => 1)
    expect(config.workers.findByName("worker").name).toBe("worker")
  })

  test("httpName from explicit web", () => {
    config.dyno("web")
    expect(config.httpName).toBe("web")
  })

  test("httpName null without explicit or identity", () => {
    expect(config.httpName).toBeNull()
  })

  test("httpName uses identity when unconfigured", () => {
    process.env.DYNO = "api.1"
    expect(config.httpName).toBe("api")
  })

  test("dispatcher returns instance", () => {
    expect(config.dispatcher).toBeInstanceOf(Dispatcher)
  })

  test("dispatcher is memoized", () => {
    expect(config.dispatcher).toBe(config.dispatcher)
  })

  test("buffer returns instance", () => {
    expect(config.buffer).toBeInstanceOf(Buffer)
  })

  test("buffer is memoized", () => {
    expect(config.buffer).toBe(config.buffer)
  })

  test("always on cpu when identity resolves", () => {
    process.env.DYNO = "worker.1"
    expect(config.activeCpuSources().map((c) => c.name)).toEqual(["worker"])
  })

  test("cpu disabled when identity unresolved", () => {
    expect(config.activeCpuSources()).toEqual([])
  })

  test("cpu disabled logs once when identity unresolved", () => {
    const warn = jest.fn()
    config.logger = { info() {}, warn, error() {} }
    config.activeCpuSources()
    config.activeCpuSources()
    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes("CPU metrics disabled"),
      ).length,
    ).toBe(1)
  })

  test("token whitespace only is treated as absent", () => {
    process.env.HIREFIRE_TOKEN = "   "
    expect(config.token).toBeNull()
    config.token = "  \t  "
    expect(config.token).toBeNull()
  })

  test("token strips surrounding whitespace", () => {
    config.token = "  abc  "
    expect(config.token).toBe("abc")
  })

  test("token strips surrounding whitespace from env only path", () => {
    process.env.HIREFIRE_TOKEN = "  abc  "
    expect(config.token).toBe("abc")
  })

  test("rqt liveness allowed when identity matches", () => {
    process.env.DYNO = "web.1"
    config.dyno("web")
    expect(config.rqtLiveness).toBe(true)
  })

  test("rqt liveness denied when identity unresolved", () => {
    config.dyno("web")
    expect(config.rqtLiveness).toBe(false)
  })

  test("rqt liveness denied when identity differs", () => {
    process.env.DYNO = "worker.1"
    config.dyno("web")
    expect(config.rqtLiveness).toBe(false)
  })

  test("rqt liveness matches case insensitively", () => {
    process.env.DYNO = "Web.1"
    config.dyno("web")
    expect(config.rqtLiveness).toBe(true)
  })

  test("rqt enabled by platform web role", () => {
    process.env.DYNO = "web.1"
    expect(config.rqtEnabled).toBe(true)
  })

  test("rqt enabled by traffic mark", () => {
    process.env.HIREFIRE_SERVICE_NAME = "api"
    config.markHttpActive()
    expect(config.rqtEnabled).toBe(true)
  })

  test("rqt enabled by explicit http", () => {
    config.dyno("web")
    expect(config.rqtEnabled).toBe(true)
  })

  test("hirefire service name web with worker dyno does not arm rqt", () => {
    process.env.HIREFIRE_SERVICE_NAME = "web"
    process.env.DYNO = "worker.1"
    expect(config.rqtEnabled).toBe(false)
  })

  test("httpSource always on under identity", () => {
    process.env.DYNO = "api.1"
    process.env.HIREFIRE_TOKEN = "t"
    config.markHttpActive()
    const source = config.httpSource
    expect(source.name).toBe("api")
    source.sample(5)
    expect(config.buffer.flush().api.rqt).toBeDefined()
  })

  test("soft identity rebuilds always on http when name changes", () => {
    process.env.DYNO = "api.1"
    const first = config.httpSource
    process.env.DYNO = "other.1"
    const second = config.httpSource
    expect(first).not.toBe(second)
    expect(second.name).toBe("other")
  })

  test("soft identity overlong once error", () => {
    const error = jest.fn()
    config.logger = { info() {}, warn() {}, error }
    process.env.HIREFIRE_SERVICE_NAME = "x".repeat(129)
    expect(config.httpName).toBeNull()
    expect(config.activeCpuSources()).toEqual([])
    expect(
      error.mock.calls.some((c) => String(c[0]).includes("exceeds 128")),
    ).toBe(true)
  })

  test("heroku config var conflict is warned", () => {
    process.env.DYNO = "worker.1"
    process.env.HIREFIRE_SERVICE_NAME = "web"
    const warn = jest.fn()
    config.logger = { info() {}, warn, error() {} }
    config.activeCpuSources()
    expect(warn.mock.calls.some((c) => String(c[0]).includes("app-wide"))).toBe(
      true,
    )
  })

  test("heroku config var conflict warned only once across cpu and rqt", () => {
    process.env.DYNO = "worker.1"
    process.env.HIREFIRE_SERVICE_NAME = "web"
    const warn = jest.fn()
    config.logger = { info() {}, warn, error() {} }

    config.dyno("web")
    config.activeCpuSources()
    config.rqtLiveness

    expect(
      warn.mock.calls.filter((c) => String(c[0]).includes("app-wide")).length,
    ).toBe(1)
  })

  test("logQueueMetrics defaults to false", () => {
    expect(config.logQueueMetrics).toBe(false)
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

  test("token empty string forces off", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    config.token = ""
    expect(config.token).toBeNull()
  })

  test("token null falls back to env", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    config.token = "x"
    config.token = null
    expect(config.token).toBe("from-env")
  })

  test("rqt liveness false when armed but identity unresolved", () => {
    config.markHttpActive()
    expect(config.rqtEnabled).toBe(true)
    expect(config.rqtLiveness).toBe(false)
    expect(config.httpSource).toBeNull()
  })

  test("rqt enabled for Render web service type", () => {
    process.env.RENDER_SERVICE_NAME = "api"
    process.env.RENDER_SERVICE_TYPE = "web"
    expect(config.rqtEnabled).toBe(true)
    expect(config.rqtLiveness).toBe(true)
    expect(config.httpName).toBe("api")
  })

  test("rqt not enabled for Render worker without traffic", () => {
    process.env.RENDER_SERVICE_NAME = "worker"
    process.env.RENDER_SERVICE_TYPE = "worker"
    expect(config.rqtEnabled).toBe(false)
  })

  test("rqt false for non-http identity without explicit web", () => {
    process.env.HIREFIRE_SERVICE_NAME = "clock"
    expect(config.rqtEnabled).toBe(false)
    expect(config.rqtLiveness).toBe(false)
  })
})
