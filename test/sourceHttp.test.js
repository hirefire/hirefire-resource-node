const { freezeTime } = require("./support")
const HTTP = require("../src/source/http")
const Buffer = require("../src/buffer")

describe("HTTP", () => {
  let configuration

  beforeEach(() => {
    configuration = { buffer: new Buffer() }
  })

  test("name", () => {
    expect(new HTTP("api", configuration).name).toBe("api")
  })

  test("sample buffers request queue time", () => {
    freezeTime(100)
    new HTTP("web", configuration).sample(25)
    expect(configuration.buffer.flush().web.rqt).toEqual({
      100: { sum: 25, count: 1 },
    })
  })
})
