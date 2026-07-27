require("../support")

describe("BullMQ plan hooks", () => {
  let bullmq

  beforeEach(() => {
    delete process.env.HIREFIRE_BULLMQ_URL
    jest.resetModules()
    bullmq = require("../../src/macro/bullmq")
  })

  test("planOptions empty", () => {
    expect(bullmq.planOptions("jqs", { a: 1 })).toEqual({})
  })

  test("planConnectionOptions from url", () => {
    process.env.HIREFIRE_BULLMQ_URL = "redis://example/1"
    expect(bullmq.planConnectionOptions()).toEqual({
      connection: "redis://example/1",
    })
  })

  test("planConnectionOptions blank ignored", () => {
    process.env.HIREFIRE_BULLMQ_URL = "   "
    expect(bullmq.planConnectionOptions()).toEqual({})
  })

  test("supports jqs only", () => {
    expect(bullmq.supportsPlanStrategy("jqs")).toBe(true)
    expect(bullmq.supportsPlanStrategy("jql")).toBe(false)
  })
})
