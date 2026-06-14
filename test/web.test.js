const { freezeTime } = require("./support")
const Web = require("../src/web")
const Buffer = require("../src/buffer")

describe("Web", () => {
  let configuration

  beforeEach(() => {
    configuration = { buffer: new Buffer() }
  })

  test("coerces the name to a string", () => {
    expect(new Web("web", configuration).name).toBe("web")
    expect(new Web("api", configuration).name).toBe("api")
  })

  test("sample delegates the queue time to the buffer", () => {
    freezeTime(1000)
    new Web("web", configuration).sample(42)
    expect(configuration.buffer.flush().web).toEqual({ 1000: [42] })
  })
})
