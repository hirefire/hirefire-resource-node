const fs = require("fs")
const net = require("net")
const path = require("path")
const tls = require("tls")
const { capture } = require("../../support")
const HireFire = require("../../../src")
const Sampler = require("../../../src/sampler")
const { jobQueueSize } = require("../../../src/macro/bullmq")
const IORedis = require("ioredis")

const fixtures = path.join(__dirname, "..", "..", "fixtures", "tls")
const redisPort = Number(process.env.REDIS_PORT || "6379")
const VARIABLES = ["DYNO", "REDIS_URL", "REDIS_TLS_URL", "HIREFIRE_BULLMQ_URL"]

describe("BullMQ over TLS with a certificate that no trust store knows", () => {
  let front
  let redis
  let url
  let saved

  beforeAll(async () => {
    front = tls.createServer(
      {
        key: fs.readFileSync(path.join(fixtures, "self-signed.key")),
        cert: fs.readFileSync(path.join(fixtures, "self-signed.crt")),
      },
      (socket) => {
        const upstream = net.connect(redisPort, "127.0.0.1")
        socket.pipe(upstream).pipe(socket)
        socket.on("error", () => upstream.destroy())
        upstream.on("error", () => socket.destroy())
      },
    )
    front.on("tlsClientError", () => {})
    await new Promise((resolve) => front.listen(0, "127.0.0.1", resolve))
    url = `rediss://127.0.0.1:${front.address().port}/0`
  })

  afterAll(async () => {
    await new Promise((resolve) => front.close(resolve))
  })

  beforeEach(async () => {
    saved = {}
    for (const name of VARIABLES) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    redis = new IORedis(`redis://127.0.0.1:${redisPort}/0`)
    await redis.flushdb()
    await redis.lpush("bull:default:wait", "1", "2", "3")
  })

  afterEach(async () => {
    for (const name of VARIABLES) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    await redis.quit()
  })

  test("off a dyno the sample fails and its error names the certificate", async () => {
    await expect(jobQueueSize("default", { connection: url })).rejects.toThrow(
      /self.signed certificate/,
    )
  })

  test("off a dyno the sample works with connectionOptions.tls", async () => {
    expect(
      await jobQueueSize("default", {
        connection: url,
        connectionOptions: { tls: { rejectUnauthorized: false } },
      }),
    ).toBe(3)
  })

  test("on a dyno the sample works without a setting", async () => {
    process.env.DYNO = "worker.1"

    expect(await jobQueueSize("default", { connection: url })).toBe(3)
  })

  test("on a dyno connectionOptions.tls that verifies the certificate is kept", async () => {
    process.env.DYNO = "worker.1"

    await expect(
      jobQueueSize("default", {
        connection: url,
        connectionOptions: { tls: { rejectUnauthorized: true } },
      }),
    ).rejects.toThrow(/self.signed certificate/)
  })

  test.each(["REDIS_URL", "HIREFIRE_BULLMQ_URL"])(
    "on a dyno a plan entry is sampled through %s",
    async (variable) => {
      process.env.DYNO = "worker.1"
      process.env[variable] = url
      const lines = capture()

      await new Sampler(HireFire.configuration).round(
        [
          {
            name: "worker",
            strategy: "jqs",
            adapter: "bullmq",
            queues: ["default"],
          },
        ],
        () => true,
      )

      expect(lines).toEqual([])
      const data = HireFire.configuration.buffer.flush()
      expect(Object.values(data.worker.jqs)).toEqual([3])
    },
  )
})
