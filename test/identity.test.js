require("./support")
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
    // One trailing "-<alnum>" segment is not a Fir pod suffix (needs two).
    process.env.DYNO = "worker-abc123"
    expect(Identity.resolve()).toBe("worker-abc123")
  })
})
