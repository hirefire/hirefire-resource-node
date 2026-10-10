const cluster = require("cluster")
const http = require("http")
const path = require("path")
const { execFile } = require("child_process")
const { Worker } = require("worker_threads")
const Host = require("../src/host")

function run(...args) {
  return runFixture("report.js", ...args)
}

function runFixture(name, ...args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, "fixtures", "host", name), ...args],
      {
        env: {
          PATH: process.env.PATH,
          HIREFIRE_TOKEN: "host-token",
          HIREFIRE_DATA_URL: "http://127.0.0.1:9",
          DYNO: "web.1",
        },
        timeout: 20_000,
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`${error.message}\n${stderr}`))
        else resolve(stdout.trim().split("\n"))
      },
    )
  })
}

describe("Host", () => {
  afterEach(() => {
    delete cluster.workers.test
  })

  test("the main thread of a process without cluster workers starts at boot", () => {
    expect(Host.startsAtBoot()).toBe(true)
  })

  test("a cluster primary with a worker does not start at boot", () => {
    cluster.workers.test = {}

    expect(Host.startsAtBoot()).toBe(false)
  })

  test("a worker thread below a thread that loaded the client does not start at boot", async () => {
    const source = `
      const { parentPort } = require("worker_threads")
      const Host = require(${JSON.stringify(require.resolve("../src/host"))})
      parentPort.postMessage(Host.startsAtBoot())
    `
    const answer = await new Promise((resolve, reject) => {
      const worker = new Worker(source, { eval: true })
      worker.once("message", resolve)
      worker.once("error", reject)
    })

    expect(answer).toBe(false)
  })

  describe("in real processes", () => {
    test("a cluster primary stops at its first fork, its worker reports, and the primary reports again when it is alone", async () => {
      expect(await run("cluster")).toEqual([
        "primary booted true",
        "worker booted true",
        "primary forked false",
        "primary alone true",
      ])
    })

    test("a cluster primary that has served a request keeps reporting beside its worker", async () => {
      expect(await run("cluster", "serves")).toEqual([
        "primary booted true",
        "primary served true",
        "worker booted true",
        "primary forked true",
        "primary alone true",
      ])
    })

    test("a worker thread starts nothing beside the main thread", async () => {
      expect(await run("thread")).toEqual([
        "main booted true",
        "thread booted false",
        "main threaded true",
      ])
    })

    test("a worker thread with no client above it starts at boot, and its helper thread starts nothing", async () => {
      expect(await runFixture("thread_app.js")).toEqual([
        "app booted true",
        "app loaded again true",
        "helper booted false",
      ])
    })

    test("a worker thread starts with the first request it serves", async () => {
      expect(await run("thread", "serves")).toEqual([
        "main booted true",
        "thread booted false",
        "thread served true",
        "main threaded true",
      ])
    })

    async function runAgainstServer(name) {
      const paths = new Set()
      const server = http.createServer((request, response) => {
        paths.add(request.url)
        request.resume().on("end", () => {
          response.writeHead(200, {
            "HireFire-Lease": "granted",
            "HireFire-Lease-TTL": "5",
            "HireFire-Sample-Frequency": "1",
            "HireFire-Dispatch-Frequency": "1",
          })
          response.end(
            JSON.stringify({
              job_queues: [{ name: "worker", strategy: "jqs" }],
            }),
          )
        })
      })
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))

      const outcome = await new Promise((resolve) => {
        execFile(
          process.execPath,
          [path.join(__dirname, "fixtures", "host", name)],
          {
            env: {
              PATH: process.env.PATH,
              HIREFIRE_TOKEN: "host-token",
              HIREFIRE_DATA_URL: `http://127.0.0.1:${server.address().port}`,
              DYNO: "web.1",
            },
            timeout: 6_000,
          },
          (error) => resolve(error ? error.signal || error.code : 0),
        )
      })
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
      return { outcome, paths: [...paths].sort() }
    }

    test("a process with nothing left to do exits while the loops of the client sleep", async () => {
      expect(await runAgainstServer("exit.js")).toEqual({
        outcome: 0,
        paths: ["/metrics/ingest", "/metrics/lease"],
      })
    }, 15_000)

    test("a process that never calls configure starts with its first request", async () => {
      expect(await runAgainstServer("request.js")).toEqual({
        outcome: 0,
        paths: ["/metrics/ingest"],
      })
    }, 15_000)
  })
})
