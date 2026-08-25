const Identity = require("../src/identity")

describe("Identity", () => {
  test("resolves to null when nothing is set", () => {
    expect(Identity.resolve()).toBeNull()
  })

  test("explicit service name wins", () => {
    process.env.HIREFIRE_SERVICE_NAME = "clock"
    process.env.DYNO = "web.1"
    process.env.RENDER_SERVICE_NAME = "api"
    expect(Identity.resolve()).toBe("clock")
  })

  test("falls back to heroku dyno prefix", () => {
    process.env.DYNO = "worker.42"
    expect(Identity.resolve()).toBe("worker")
  })

  test("resolves fir pod names", () => {
    process.env.DYNO = "web-5fb9c979-lft2l"
    expect(Identity.resolve()).toBe("web")
  })

  test("resolves fir pod names with mixed case suffixes", () => {
    process.env.DYNO = "web-12A34B56D-E78F9"
    expect(Identity.resolve()).toBe("web")
  })

  test("resolves fir pod names with underscores", () => {
    process.env.DYNO = "worker_latency-6d7f788ddb-cdct6"
    expect(Identity.resolve()).toBe("worker_latency")
  })

  test("fir pod name preserves dashes inside the process name", () => {
    process.env.DYNO = "my-worker-5fb9c979-lft2l"
    expect(Identity.resolve()).toBe("my-worker")
  })

  test("falls back to render service name", () => {
    process.env.RENDER_SERVICE_NAME = "background-worker"
    expect(Identity.resolve()).toBe("background-worker")
  })

  test("blank values are ignored", () => {
    process.env.HIREFIRE_SERVICE_NAME = ""
    process.env.DYNO = "web.1"
    expect(Identity.resolve()).toBe("web")
  })

  test("strips whitespace from identity env", () => {
    process.env.HIREFIRE_SERVICE_NAME = "  clock  \n"
    expect(Identity.resolve()).toBe("clock")

    delete process.env.HIREFIRE_SERVICE_NAME
    process.env.DYNO = "  worker.1  "
    expect(Identity.resolve()).toBe("worker")

    delete process.env.DYNO
    process.env.RENDER_SERVICE_NAME = "\tapi\t"
    expect(Identity.resolve()).toBe("api")
  })

  test("whitespace only identity env is absent", () => {
    process.env.HIREFIRE_SERVICE_NAME = "   "
    process.env.DYNO = "web.1"
    expect(Identity.resolve()).toBe("web")
  })

  test("heroku conflict when explicit disagrees with dyno prefix", () => {
    process.env.HIREFIRE_SERVICE_NAME = "web"
    process.env.DYNO = "worker.1"
    expect(Identity.herokuConflict()).toBe(true)
  })

  test("no heroku conflict when they agree", () => {
    process.env.HIREFIRE_SERVICE_NAME = "worker"
    process.env.DYNO = "worker.1"
    expect(Identity.herokuConflict()).toBe(false)
  })

  test("no heroku conflict without dyno", () => {
    process.env.HIREFIRE_SERVICE_NAME = "web"
    expect(Identity.herokuConflict()).toBe(false)
  })

  test("no heroku conflict when names differ only in case", () => {
    process.env.HIREFIRE_SERVICE_NAME = "Worker"
    process.env.DYNO = "worker.1"
    expect(Identity.herokuConflict()).toBe(false)
  })

  test("heroku dyno takes precedence over render service name", () => {
    process.env.DYNO = "worker.1"
    process.env.RENDER_SERVICE_NAME = "api"
    expect(Identity.resolve()).toBe("worker")
  })

  test("dyno name without a suffix is returned as is", () => {
    process.env.DYNO = "web"
    expect(Identity.resolve()).toBe("web")
  })

  test("dyno name with a single trailing segment is preserved", () => {
    process.env.DYNO = "worker-abc123"
    expect(Identity.resolve()).toBe("worker-abc123")
  })

  test("dyno that strips to empty is unresolved", () => {
    process.env.DYNO = ".1"
    expect(Identity.resolve()).toBeNull()

    process.env.DYNO = "-ab-cd"
    expect(Identity.resolve()).toBeNull()
  })

  test("platform http role heroku cedar web", () => {
    process.env.DYNO = "web.1"
    expect(Identity.herokuWebProcess()).toBe(true)
    expect(Identity.platformHttpRole()).toBe(true)
  })

  test("platform http role heroku fir web", () => {
    process.env.DYNO = "web-5fb9c979-lft2l"
    expect(Identity.herokuWebProcess()).toBe(true)
    expect(Identity.platformHttpRole()).toBe(true)
  })

  test("platform http role heroku worker is not web", () => {
    for (const dyno of ["worker.1", "worker.42"]) {
      process.env.DYNO = dyno
      expect(Identity.herokuWebProcess()).toBe(false)
      expect(Identity.platformHttpRole()).toBe(false)
    }
  })

  test("platform http role uses dyno not explicit service name", () => {
    process.env.HIREFIRE_SERVICE_NAME = "web"
    process.env.DYNO = "worker.1"
    expect(Identity.platformHttpRole()).toBe(false)
  })

  test("platform http role render web service type", () => {
    process.env.RENDER_SERVICE_NAME = "api"
    process.env.RENDER_SERVICE_TYPE = "web"
    expect(Identity.renderWebService()).toBe(true)
    expect(Identity.platformHttpRole()).toBe(true)
  })

  test("platform http role is case insensitive", () => {
    process.env.DYNO = "Web.1"
    expect(Identity.platformHttpRole()).toBe(true)

    delete process.env.DYNO
    process.env.RENDER_SERVICE_NAME = "api"
    process.env.RENDER_SERVICE_TYPE = "Web"
    expect(Identity.platformHttpRole()).toBe(true)
  })

  test("platform http role render worker type", () => {
    process.env.RENDER_SERVICE_NAME = "worker"
    process.env.RENDER_SERVICE_TYPE = "worker"
    expect(Identity.renderWebService()).toBe(false)
    expect(Identity.platformHttpRole()).toBe(false)
  })

  test("platform http role render pserv is not web role", () => {
    process.env.RENDER_SERVICE_TYPE = "pserv"
    expect(Identity.platformHttpRole()).toBe(false)
  })

  test("platform http role false with no platform env", () => {
    expect(Identity.platformHttpRole()).toBe(false)
    expect(Identity.herokuWebProcess()).toBe(false)
    expect(Identity.renderWebService()).toBe(false)
  })

  test("heroku web process rejects names that only start with web", () => {
    for (const dyno of ["webworker.1", "webbing.1", "web_service.1"]) {
      process.env.DYNO = dyno
      expect(Identity.herokuWebProcess()).toBe(false)
      expect(Identity.platformHttpRole()).toBe(false)
    }
  })

  test("heroku web process rejects fir worker", () => {
    process.env.DYNO = "worker-12a34b56d-e78f9"
    expect(Identity.herokuWebProcess()).toBe(false)
    expect(Identity.platformHttpRole()).toBe(false)
  })

  test("heroku conflict false when only dyno present", () => {
    process.env.DYNO = "web.1"
    expect(Identity.herokuConflict()).toBe(false)
  })

  test("render service type blank is not web role", () => {
    process.env.RENDER_SERVICE_NAME = "api"
    process.env.RENDER_SERVICE_TYPE = "   "
    expect(Identity.renderWebService()).toBe(false)
    expect(Identity.platformHttpRole()).toBe(false)
  })
})
