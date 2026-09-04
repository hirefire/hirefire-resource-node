function expectIntegerCount(value) {
  expect(typeof value).toBe("number")
  expect(Number.isFinite(value)).toBe(true)
  expect(Number.isInteger(value)).toBe(true)
}

function expectLatencyNumber(value) {
  expect(typeof value).toBe("number")
  expect(Number.isFinite(value)).toBe(true)
}

module.exports = { expectIntegerCount, expectLatencyNumber }
