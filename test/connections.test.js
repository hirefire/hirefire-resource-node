const { local, capture } = require("./support")
const HireFire = require("../src")
const Dispatcher = require("../src/dispatcher")

describe("the connections of a client", () => {
  let sockets
  let paths
  let delay
  let lines

  async function until(condition) {
    const deadline = Date.now() + 4000
    while (!condition()) {
      if (Date.now() > deadline) throw new Error("the condition never held")
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  beforeEach(async () => {
    sockets = new Set()
    paths = []
    delay = 0
    const server = await local((request, response) => {
      paths.push(request.url)
      request.resume().on("end", () => {
        setTimeout(() => {
          response.writeHead(200, { "HireFire-Lease-Granted": "false" })
          response.end()
        }, delay)
      })
    })
    server.keepAliveTimeout = 60_000
    server.on("connection", (socket) => {
      sockets.add(socket)
      socket.on("close", () => sockets.delete(socket))
    })

    process.env.HIREFIRE_TOKEN = "test-token-value"
    process.env.HIREFIRE_DATA_URL = `http://127.0.0.1:${server.address().port}`
    HireFire.configure((config) => config.dyno("worker", () => 1))
    lines = capture()
    HireFire.configuration.buffer.sample("worker", "jqs", 1)
    await until(() => paths.length === 2)
  })

  function dispatcher() {
    return HireFire.configuration.dispatcher
  }

  test("are one for its dispatches and one for the lease, kept open between requests", async () => {
    expect(paths.sort()).toEqual(["/metrics/ingest", "/metrics/lease"])
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(sockets.size).toBe(2)
  }, 10_000)

  test("are closed by a stop", async () => {
    await dispatcher().stop()

    await until(() => sockets.size === 0)
  }, 10_000)

  test("are closed by a stop without a flush", async () => {
    await dispatcher().stop({ flush: false })

    await until(() => sockets.size === 0)
  }, 10_000)

  test("are closed when the request ends that a stop gave up on", async () => {
    jest.replaceProperty(Dispatcher, "JOIN_TIMEOUT", 0.05)
    delay = 400
    HireFire.configuration.buffer.sample("worker", "jqs", 1)
    await until(() => paths.length === 3)

    await dispatcher().stop()

    expect(lines).toContainEqual([
      "warn",
      "[HireFire] The dispatch loop did not stop within 0.05 seconds. The final flush is skipped.",
    ])
    expect(sockets.size).toBeGreaterThan(0)
    await until(() => sockets.size === 0)
  }, 10_000)
})
