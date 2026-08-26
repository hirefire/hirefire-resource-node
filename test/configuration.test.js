const Configuration = require("../src/configuration")
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

  test("can set logger", () => {
    const custom = { info() {} }
    config.logger = custom
    expect(config.logger).toBe(custom)
  })

  test("web default to null", () => {
    expect(config.http).toBeNull()
  })

  test("job queues default to empty", () => {
    expect(config.jobQueues.any()).toBe(false)
  })

  test("dyno bare web is noop", () => {
    config.dyno("web")
    expect(config.http).toBeNull()
    expect(config.rqtEnabled).toBe(false)
    expect(config.jobQueues.any()).toBe(false)
  })

  test("dyno bare web is case insensitive noop", () => {
    config.dyno("Web")
    expect(config.http).toBeNull()
    expect(config.rqtEnabled).toBe(false)
  })

  test("dyno bare web warns once", () => {
    const warn = jest.fn()
    config.logger = { info() {}, warn, error() {} }
    config.dyno("web")
    config.dyno("Web")
    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes('config.dyno("web") is deprecated'),
      ).length,
    ).toBe(1)
    expect(String(warn.mock.calls[0][0])).toMatch(/You can remove/)
    expect(String(warn.mock.calls[0][0])).toMatch(/does nothing/)
  })

  test("dyno with a function configures a job queue", async () => {
    config.dyno("worker", () => 1.23)
    config.dyno("mailer", () => 2.46)
    const workers = [...config.jobQueues]
    expect(workers.map((w) => w.name)).toEqual(["worker", "mailer"])
    expect(await workers[0].sample()).toBe(1.23)
    expect(await workers[1].sample()).toBe(2.46)
  })

  test("dyno without function raises for a non web name", () => {
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
    expect(config.jobQueues.findByName("worker").name).toBe("worker")
  })

  test("dyno rejects name over max bytes", () => {
    const tooLong = "w".repeat(129)
    expect(() => config.dyno(tooLong, () => 1)).toThrow(/128/)
  })

  test("dyno name limit counts utf8 bytes", () => {
    const accepted = "é".repeat(64)
    const tooLong = "é".repeat(65)

    config.dyno(accepted, () => 1)
    expect([...config.jobQueues][0].name).toBe(accepted)
    expect(() => config.dyno(tooLong, () => 1)).toThrow(/128/)
  })

  test("duplicate job queue raises", () => {
    config.dyno("worker", () => 1)
    expect(() => config.dyno("worker", () => 2)).toThrow(
      Configuration.DuplicateDynoError,
    )
  })

  test("duplicate name guard is case insensitive", () => {
    config.dyno("worker", () => 1)
    expect(() => config.dyno("Worker", () => 2)).toThrow(
      Configuration.DuplicateDynoError,
    )
  })

  test("bare web then job queue under web", () => {
    config.dyno("web")
    config.dyno("web", () => 1)
    expect(config.http).toBeNull()
    expect([...config.jobQueues].map((w) => w.name)).toEqual(["web"])
  })

  test("canonical name preserves first seen casing", () => {
    config.dyno("Web", () => 1)
    expect([...config.jobQueues][0].name).toBe("Web")
  })

  test("rejected registration does not reserve name", () => {
    expect(() => config.dyno("worker")).toThrow(
      Configuration.MissingSamplerError,
    )
    config.dyno("worker", () => 1)
    expect(config.jobQueues.findByName("worker").name).toBe("worker")
  })

  test("http name not forced by bare web", () => {
    config.dyno("web")
    expect(config.httpName).toBeNull()
  })

  test("http name null without explicit or identity", () => {
    expect(config.httpName).toBeNull()
  })

  test("http name uses identity when unconfigured", () => {
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
    expect(config.rqtLiveness).toBe(true)
  })

  test("rqt liveness denied when identity unresolved", () => {
    config.markHttpActive()
    expect(config.rqtLiveness).toBe(false)
  })

  test("rqt liveness when identity and traffic match", () => {
    process.env.DYNO = "worker.1"
    config.markHttpActive()
    expect(config.rqtLiveness).toBe(true)
  })

  test("rqt liveness matches case insensitively", () => {
    process.env.DYNO = "Web.1"
    expect(config.rqtLiveness).toBe(true)
  })

  test("rqt enabled for heroku web process without explicit web", () => {
    process.env.DYNO = "web.1"
    expect(config.rqtEnabled).toBe(true)
  })

  test("rqt enabled after middleware marks http active", () => {
    process.env.HIREFIRE_SERVICE_NAME = "api"
    config.markHttpActive()
    expect(config.rqtEnabled).toBe(true)
  })

  test("bare web does not arm rqt", () => {
    config.dyno("web")
    expect(config.rqtEnabled).toBe(false)
  })

  test("rqt not enabled by explicit service name web on worker dyno", () => {
    process.env.HIREFIRE_SERVICE_NAME = "web"
    process.env.DYNO = "worker.1"
    expect(config.rqtEnabled).toBe(false)
  })

  test("http source always on under identity", () => {
    process.env.DYNO = "api.1"
    process.env.HIREFIRE_TOKEN = "t"
    config.markHttpActive()
    const source = config.httpSource
    expect(source.name).toBe("api")
    source.sample(5)
    expect(config.buffer.flush().api.rqt).toBeDefined()
  })

  test("http source rebuilds when identity name changes", () => {
    process.env.DYNO = "api.1"
    const first = config.httpSource
    process.env.DYNO = "other.1"
    const second = config.httpSource
    expect(first).not.toBe(second)
    expect(second.name).toBe("other")
  })

  test("soft identity over max bytes disables http and cpu and warns once", () => {
    const error = jest.fn()
    config.logger = { info() {}, warn() {}, error }
    process.env.HIREFIRE_SERVICE_NAME = "x".repeat(129)
    expect(config.httpName).toBeNull()
    expect(config.httpSource).toBeNull()
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

  test("heroku config var conflict warned only once", () => {
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

  test("token defaults to env", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    expect(config.token).toBe("from-env")
  })

  test("token can be overridden", () => {
    process.env.HIREFIRE_TOKEN = "from-env"
    config.token = "custom-token"
    expect(config.token).toBe("custom-token")
  })

  test("token empty string is treated as absent", () => {
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

  test("unresolved armed rqt identity warns once", () => {
    process.env.HIREFIRE_TOKEN = "t"
    const warn = jest.fn()
    config.logger = { info() {}, warn, error() {} }
    config.markHttpActive()

    expect(config.httpSource).toBeNull()
    expect(config.httpSource).toBeNull()

    expect(
      warn.mock.calls.filter((c) =>
        String(c[0]).includes("Request queue time samples dropped"),
      ),
    ).toHaveLength(1)
  })

  test("rqt enabled for render web service type", () => {
    process.env.RENDER_SERVICE_NAME = "api"
    process.env.RENDER_SERVICE_TYPE = "web"
    expect(config.rqtEnabled).toBe(true)
    expect(config.rqtLiveness).toBe(true)
    expect(config.httpName).toBe("api")
  })

  test("rqt not enabled for render worker without traffic", () => {
    process.env.RENDER_SERVICE_NAME = "worker"
    process.env.RENDER_SERVICE_TYPE = "worker"
    expect(config.rqtEnabled).toBe(false)
  })

  test("rqt liveness false for non http identity without explicit web", () => {
    process.env.HIREFIRE_SERVICE_NAME = "clock"
    expect(config.rqtEnabled).toBe(false)
    expect(config.rqtLiveness).toBe(false)
  })
})
