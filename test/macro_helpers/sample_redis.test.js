jest.mock("ioredis", () => jest.fn())

const IORedis = require("ioredis")
const { sample } = require("../../src/macro/helpers/sample_redis")
const sampleRound = require("../../src/sample_round")

const URL = "redis://127.0.0.1:6379/0"
const SECURE_URL = "rediss://127.0.0.1:6379/0"
const LADDER = [
  "DYNO",
  "REDIS_TLS_URL",
  "REDIS_URL",
  "REDISTOGO_URL",
  "REDISCLOUD_URL",
  "OPENREDIS_URL",
]

describe("the Redis sample helper", () => {
  let clients
  let replies
  let pages
  let saved

  function waiting(args, states = ["wait"]) {
    return sample(
      args,
      states,
      (pipeline, key) => pipeline.llen(`${key}wait`),
      ([wait]) => Number(wait),
    )
  }

  function client(options = {}) {
    const commands = []
    const made = {
      commands,
      options: { host: "127.0.0.1", port: 6379, db: 0, ...options },
      on: jest.fn(),
      quit: jest.fn().mockResolvedValue("OK"),
      disconnect: jest.fn(),
      scan: jest.fn(async () => pages.shift() ?? ["0", []]),
      pipeline: () => ({
        llen(key) {
          commands.push(["llen", key])
        },
        zcard(key) {
          commands.push(["zcard", key])
        },
        exec: jest.fn(async () => {
          if (replies instanceof Error) throw replies
          return replies ?? commands.map(() => [null, 0])
        }),
      }),
    }
    clients.push(made)
    return made
  }

  beforeEach(() => {
    clients = []
    replies = null
    pages = []
    saved = {}
    for (const name of LADDER) {
      saved[name] = process.env[name]
      delete process.env[name]
    }
    IORedis.mockImplementation((first) =>
      client(typeof first === "object" ? first : {}),
    )
  })

  afterEach(() => {
    for (const name of LADDER) {
      if (saved[name] === undefined) delete process.env[name]
      else process.env[name] = saved[name]
    }
    jest.resetAllMocks()
  })

  test("a URL opens a client with the limits of a sample", async () => {
    await waiting(["default", { connection: URL }])

    expect(IORedis).toHaveBeenCalledTimes(1)
    const [url, options] = IORedis.mock.calls[0]
    expect(url).toBe(URL)
    expect(options).toEqual({
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      commandTimeout: 5000,
      enableOfflineQueue: true,
      retryStrategy: expect.any(Function),
    })
    expect([1, 2, 3, 4].map(options.retryStrategy)).toEqual([
      50,
      100,
      null,
      null,
    ])
  })

  test("connection options of the caller win over the limits of a sample", async () => {
    await waiting([
      "default",
      {
        connection: URL,
        connectionOptions: { connectTimeout: 1234, maxRetriesPerRequest: 3 },
      },
    ])

    expect(IORedis.mock.calls[0][1]).toMatchObject({
      connectTimeout: 1234,
      maxRetriesPerRequest: 3,
      commandTimeout: 5000,
    })
  })

  test("an options object opens a client from it, under the connection options and over the limits", async () => {
    await waiting([
      "default",
      {
        connection: { host: "10.0.0.5", port: 6380, connectTimeout: 100 },
        connectionOptions: { db: 3 },
      },
    ])

    expect(IORedis.mock.calls[0]).toEqual([
      {
        maxRetriesPerRequest: 1,
        connectTimeout: 100,
        commandTimeout: 5000,
        enableOfflineQueue: true,
        retryStrategy: expect.any(Function),
        host: "10.0.0.5",
        port: 6380,
        db: 3,
      },
    ])
  })

  test("a client of the app is duplicated with the limits of a sample, and is not closed", async () => {
    const copies = []
    const app = {
      options: { host: "10.0.0.5", port: 6380, enableOfflineQueue: false },
      quit: jest.fn(),
      disconnect: jest.fn(),
      duplicate: jest.fn((overrides) => {
        copies.push(client({ ...app.options, ...overrides }))
        return copies.at(-1)
      }),
    }
    process.env.DYNO = "worker.1"
    replies = [[null, 6]]

    const total = await waiting([
      "default",
      { connection: app, connectionOptions: { db: 3 } },
    ])

    expect(total).toBe(6)
    expect(IORedis).not.toHaveBeenCalled()
    expect(app.duplicate.mock.calls).toEqual([
      [
        {
          maxRetriesPerRequest: 1,
          connectTimeout: 5000,
          commandTimeout: 5000,
          enableOfflineQueue: true,
          retryStrategy: expect.any(Function),
          db: 3,
        },
      ],
    ])
    expect(copies[0].quit).toHaveBeenCalledTimes(1)
    expect(app.quit).not.toHaveBeenCalled()
    expect(app.disconnect).not.toHaveBeenCalled()
  })

  test("without a connection the first variable of the ladder that is set is used", async () => {
    await waiting(["default"])
    expect(IORedis.mock.calls[0][0]).toBe("redis://localhost:6379/0")

    for (const name of LADDER.slice(1).reverse()) {
      process.env[name] = `redis://${name.toLowerCase()}:6379/0`
      await waiting(["default"])
      expect(IORedis.mock.calls.at(-1)[0]).toBe(process.env[name])
    }

    await waiting(["default", { connection: URL }])
    expect(IORedis.mock.calls.at(-1)[0]).toBe(URL)
  })

  describe("on a dyno", () => {
    beforeEach(() => {
      process.env.DYNO = "worker.1"
    })

    test("a rediss URL connects without certificate verification", async () => {
      await waiting(["default", { connection: SECURE_URL }])
      process.env.REDIS_URL = SECURE_URL
      await waiting(["default"])

      for (const [url, options] of IORedis.mock.calls) {
        expect(url).toBe(SECURE_URL)
        expect(options.tls).toEqual({ rejectUnauthorized: false })
      }
      expect(IORedis).toHaveBeenCalledTimes(2)
    })

    test.each([[{}], [{ rejectUnauthorized: true }], [{ ca: "certificate" }]])(
      "connectionOptions.tls %j is used as given",
      async (tls) => {
        await waiting([
          "default",
          { connection: SECURE_URL, connectionOptions: { tls } },
        ])

        expect(IORedis.mock.calls[0][1].tls).toBe(tls)
      },
    )

    test("a redis URL and an options object get no TLS option", async () => {
      await waiting(["default", { connection: URL }])
      await waiting(["default", { connection: "REDISS://127.0.0.1:6379/0" }])
      await waiting(["default", { connection: { host: "127.0.0.1" } }])

      expect(IORedis.mock.calls[0][1]).not.toHaveProperty("tls")
      expect(IORedis.mock.calls[1][1]).not.toHaveProperty("tls")
      expect(IORedis.mock.calls[2][0]).not.toHaveProperty("tls")
    })
  })

  test("off a dyno a rediss URL gets no TLS option", async () => {
    await waiting(["default", { connection: SECURE_URL }])
    process.env.DYNO = ""
    await waiting(["default", { connection: SECURE_URL }])

    expect(IORedis.mock.calls[0][1]).not.toHaveProperty("tls")
    expect(IORedis.mock.calls[1][1]).not.toHaveProperty("tls")
  })

  test("the first error event of the client is added to the error of a failed sample", async () => {
    IORedis.mockImplementation(() => {
      const made = client()
      made.pipeline = () => ({
        llen() {},
        exec: async () => {
          const listener = made.on.mock.calls[0][1]
          listener(new Error("self-signed certificate"))
          listener(new Error("second error"))
          throw new Error("Reached the max retries per request limit")
        },
      })
      return made
    })

    await expect(waiting(["default", { connection: URL }])).rejects.toThrow(
      /^Reached the max retries per request limit \(self-signed certificate\)$/,
    )
  })

  test("an error that is itself the error event is left as it is, and so is a failure without an error event", async () => {
    const refused = new Error("connect ECONNREFUSED")
    IORedis.mockImplementationOnce(() => {
      const made = client()
      made.pipeline = () => ({
        llen() {},
        exec: async () => {
          made.on.mock.calls[0][1](refused)
          throw refused
        },
      })
      return made
    })

    await expect(waiting(["default", { connection: URL }])).rejects.toThrow(
      /^connect ECONNREFUSED$/,
    )

    replies = new Error("pipeline failed")
    await expect(waiting(["default", { connection: URL }])).rejects.toThrow(
      /^pipeline failed$/,
    )
  })

  test("queue names are trimmed and counted once, and the replies of each queue are counted apart", async () => {
    replies = [
      [null, 2],
      [null, "3"],
    ]
    const seen = []

    const total = await sample(
      [" default ", "default", ["mailer", null, "  "], { connection: URL }],
      ["wait"],
      (pipeline, key) => pipeline.llen(`${key}wait`),
      (queue) => {
        seen.push(queue)
        return Number(queue[0])
      },
    )

    expect(total).toBe(5)
    expect(seen).toEqual([[2], ["3"]])
    expect(clients[0].commands).toEqual([
      ["llen", "bull:default:wait"],
      ["llen", "bull:mailer:wait"],
    ])
    expect(clients[0].scan).not.toHaveBeenCalled()
  })

  test("every reply of a queue reaches its count, in the order of the commands", async () => {
    replies = [
      [null, 1],
      [null, 2],
      [null, 3],
      [null, 4],
    ]
    const seen = []

    await sample(
      ["a", "b", { connection: URL }],
      ["wait"],
      (pipeline, key) => {
        pipeline.llen(`${key}wait`)
        pipeline.zcard(`${key}delayed`)
      },
      (queue) => seen.push(queue),
    )

    expect(seen).toEqual([
      [1, 2],
      [3, 4],
    ])
    expect(clients[0].commands).toEqual([
      ["llen", "bull:a:wait"],
      ["zcard", "bull:a:delayed"],
      ["llen", "bull:b:wait"],
      ["zcard", "bull:b:delayed"],
    ])
  })

  test("a total below zero is zero", async () => {
    const total = await sample(
      ["default", { connection: URL }],
      ["wait"],
      (pipeline, key) => pipeline.llen(`${key}wait`),
      () => -1,
    )

    expect(total).toBe(0)
  })

  test("the error of one command fails the sample, and the client is closed", async () => {
    replies = [
      [null, 1],
      [new Error("WRONGTYPE"), null],
    ]

    await expect(waiting(["a", "b", { connection: URL }])).rejects.toThrow(
      "WRONGTYPE",
    )
    expect(clients[0].quit).toHaveBeenCalledTimes(1)
  })

  test("the client is closed after a sample, after a failed pipeline, and after a failed walk", async () => {
    await waiting(["default", { connection: URL }])
    expect(clients[0].quit).toHaveBeenCalledTimes(1)
    expect(clients[0].disconnect).not.toHaveBeenCalled()

    replies = new Error("pipeline failed")
    await expect(waiting(["default", { connection: URL }])).rejects.toThrow(
      "pipeline failed",
    )
    expect(clients[1].quit).toHaveBeenCalledTimes(1)

    replies = null
    IORedis.mockImplementationOnce(() => {
      const made = client()
      made.scan.mockRejectedValue(new Error("walk failed"))
      return made
    })
    await expect(waiting([{ connection: URL }])).rejects.toThrow("walk failed")
    expect(clients[2].quit).toHaveBeenCalledTimes(1)
  })

  test("a client that cannot quit is disconnected, and the outcome of the sample stands", async () => {
    IORedis.mockImplementation(() => {
      const made = client()
      made.quit.mockRejectedValue(new Error("quit failed"))
      return made
    })
    replies = [[null, 4]]

    await expect(waiting(["default", { connection: URL }])).resolves.toBe(4)
    expect(clients[0].disconnect).toHaveBeenCalledTimes(1)

    replies = new Error("pipeline failed")
    await expect(waiting(["default", { connection: URL }])).rejects.toThrow(
      "pipeline failed",
    )
    expect(clients[1].disconnect).toHaveBeenCalledTimes(1)
  })

  test("without queue names the keys are walked page by page for the queues in one of the states", async () => {
    pages = [
      ["7", ["bull:default:wait", "bull:default:active", "bull:other:meta"]],
      ["12", []],
      ["0", ["bull:mailer:active", "bull:a:b:wait", "bull:old:completed"]],
    ]

    await waiting([{ connection: URL }], ["wait", "active"])

    expect(clients[0].scan.mock.calls).toEqual([
      ["0", "MATCH", "bull:*", "COUNT", 1000],
      ["7", "MATCH", "bull:*", "COUNT", 1000],
      ["12", "MATCH", "bull:*", "COUNT", 1000],
    ])
    expect(clients[0].commands).toEqual([
      ["llen", "bull:default:wait"],
      ["llen", "bull:mailer:wait"],
      ["llen", "bull:a:b:wait"],
    ])
  })

  test("a key counts only when the whole key has the form of a queue state", async () => {
    pages = [
      [
        "0",
        [
          "xbull:a:wait",
          "bull:b:waiting",
          "bull:c:wait:extra",
          "bull::wait",
          "bull:d:wait",
        ],
      ],
    ]

    await waiting([{ connection: URL }], ["wait"])

    expect(clients[0].commands).toEqual([
      ["llen", "bull::wait"],
      ["llen", "bull:d:wait"],
    ])
  })

  describe("a walk of many keys", () => {
    function slow(milliseconds) {
      IORedis.mockImplementationOnce(() => {
        const made = client()
        made.scan.mockImplementation(async () => {
          jest.advanceTimersByTime(milliseconds)
          return pages.shift()
        })
        return made
      })
    }

    beforeEach(() => {
      jest.useFakeTimers()
      pages = [
        ["5", ["bull:a:wait"]],
        ["9", ["bull:b:wait"]],
        ["0", ["bull:c:wait"]],
      ]
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    test("is given up after 2 seconds, with an error that asks for queue names", async () => {
      slow(1001)

      await expect(waiting([{ connection: URL }])).rejects.toThrow(
        "Listing the queues took more than 2 seconds, because the Redis " +
          "database holds many keys. Name the queues of this sample, so " +
          "that the keys are not walked.",
      )
      expect(clients[0].scan).toHaveBeenCalledTimes(2)
      expect(clients[0].commands).toEqual([])
      expect(clients[0].quit).toHaveBeenCalledTimes(1)
    })

    test("goes on at exactly 2 seconds", async () => {
      slow(1000)

      await expect(waiting([{ connection: URL }])).resolves.toBe(0)
      expect(clients[0].scan).toHaveBeenCalledTimes(3)
      expect(clients[0].commands).toHaveLength(3)
    })

    test("keeps a last page that arrives late", async () => {
      pages = [["0", ["bull:a:wait"]]]
      slow(60_000)

      await expect(waiting([{ connection: URL }])).resolves.toBe(0)
      expect(clients[0].commands).toEqual([["llen", "bull:a:wait"]])
    })

    test("measures each walk from its own start", async () => {
      slow(1500)
      pages = [["0", []]]
      await waiting([{ connection: URL }])

      slow(1500)
      pages = [
        ["5", []],
        ["0", []],
      ]
      await expect(waiting([{ connection: URL }])).resolves.toBe(0)
    })
  })

  test("a walk without queues samples nothing and gives zero", async () => {
    await expect(waiting([{ connection: URL }])).resolves.toBe(0)
    expect(clients[0].commands).toEqual([])
  })

  describe("in a sample round", () => {
    function round(body) {
      return sampleRound.run(new Map(), body)
    }

    test("the queues of one Redis are walked once", async () => {
      pages = [["0", ["bull:default:wait"]]]

      await round(async () => {
        await waiting([{ connection: URL }])
        await waiting([{ connection: URL }])
      })

      expect(clients[0].scan).toHaveBeenCalledTimes(1)
      expect(clients[1].scan).not.toHaveBeenCalled()
      expect(clients[1].commands).toEqual([["llen", "bull:default:wait"]])
    })

    test.each([
      ["host", { host: "10.0.0.5" }],
      ["port", { port: 6380 }],
      ["database", { db: 1 }],
      ["socket", { path: "/tmp/redis.sock" }],
    ])("another %s is walked apart", async (_part, other) => {
      await round(async () => {
        await waiting([{ connection: {} }])
        await waiting([{ connection: other }])
      })

      expect(clients[0].scan).toHaveBeenCalledTimes(1)
      expect(clients[1].scan).toHaveBeenCalledTimes(1)
    })

    test("other states are walked apart", async () => {
      await round(async () => {
        await waiting([{ connection: URL }], ["wait", "priority"])
        await waiting([{ connection: URL }], ["wait", "prioritized"])
      })

      expect(clients[0].scan).toHaveBeenCalledTimes(1)
      expect(clients[1].scan).toHaveBeenCalledTimes(1)
    })

    test("a failed walk fails every sample of the round that needs it", async () => {
      IORedis.mockImplementationOnce(() => {
        const made = client()
        made.scan.mockRejectedValue(new Error("walk failed"))
        return made
      })

      await round(async () => {
        await expect(waiting([{ connection: URL }])).rejects.toThrow(
          "walk failed",
        )
        await expect(waiting([{ connection: URL }])).rejects.toThrow(
          "walk failed",
        )
        await expect(waiting(["default", { connection: URL }])).resolves.toBe(0)
      })
      expect(clients[1].scan).not.toHaveBeenCalled()
    })

    test("the next round walks again, and so does a sample outside a round", async () => {
      await round(() => waiting([{ connection: URL }]))
      await round(() => waiting([{ connection: URL }]))
      await waiting([{ connection: URL }])
      await waiting([{ connection: URL }])

      expect(clients.map((made) => made.scan.mock.calls.length)).toEqual([
        1, 1, 1, 1,
      ])
    })
  })
})
