const net = require("net")
const nock = require("nock")
const { Client } = require("../src/client")

describe("test support", () => {
  test("a request that no test intercepts never leaves the machine", async () => {
    const connect = jest.spyOn(net.Socket.prototype, "connect")
    const client = new Client({ token: "test-token-value" })
    nock.cleanAll()
    try {
      await expect(client.submitSamples("[]")).rejects.toThrow(
        "Disallowed net connect",
      )
      expect(connect).not.toHaveBeenCalled()
    } finally {
      await client.close()
    }
  })
})
