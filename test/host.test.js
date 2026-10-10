const cluster = require("cluster")
const path = require("path")
const { execFile } = require("child_process")
const { Worker } = require("worker_threads")
const Host = require("../src/host")

const fixture = path.join(__dirname, "fixtures", "host", "report.js")

function run(...args) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [fixture, ...args],
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

  test("the main thread of a process without cluster workers reports", () => {
    expect(Host.reports()).toBe(true)
  })

  test("a cluster primary with a worker does not report", () => {
    cluster.workers.test = {}

    expect(Host.reports()).toBe(false)
  })

  test("a worker thread does not report", async () => {
    const source = `
      const { parentPort } = require("worker_threads")
      const Host = require(${JSON.stringify(require.resolve("../src/host"))})
      parentPort.postMessage(Host.reports())
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

    test("a cluster primary that asks for it keeps reporting beside its worker", async () => {
      expect(await run("cluster", "force")).toEqual([
        "primary booted true",
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

    test("a worker thread that asks for it reports", async () => {
      expect(await run("thread", "force")).toEqual([
        "main booted true",
        "thread booted true",
        "main threaded true",
      ])
    })
  })
})
