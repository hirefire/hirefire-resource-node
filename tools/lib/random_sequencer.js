"use strict"

const Sequencer = require("@jest/test-sequencer").default

function generator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

class RandomSequencer extends Sequencer {
  sort(tests) {
    const random = generator(Number(process.env.TOOLS_SEED || 1))
    const ordered = [...tests].sort((a, b) => (a.path < b.path ? -1 : 1))
    for (let index = ordered.length - 1; index > 0; index -= 1) {
      const other = Math.floor(random() * (index + 1))
      const held = ordered[index]
      ordered[index] = ordered[other]
      ordered[other] = held
    }
    return ordered
  }
}

module.exports = RandomSequencer
