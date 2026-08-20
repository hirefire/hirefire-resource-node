const { freezeTime } = require("./support")
const HTTP = require("../src/source/http")
const Buffer = require("../src/buffer")

describe("HTTP", () => {
  let configuration

  beforeEach(() => {
    configuration = { buffer: new Buffer() }
  })

  test("coerces the name to a string", () => {
    expect(new HTTP("web", configuration).name).toBe("web")
    expect(new HTTP("api", configuration).name).toBe("api")
  })

  test("sample buffers request queue time", () => {
    freezeTime(1000)
    new HTTP("web", configuration).sample(42)
    expect(configuration.buffer.flush().web.rqt).toEqual({
      1000: { sum: 42, count: 1 },
    })
  })
})
