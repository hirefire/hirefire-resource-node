/* global describe, expect, test */

const HireFire = require('../src')
const { Configuration } = require('../src/configuration')

describe('HireFire', () => {
  test('configure yields configuration', () => {
    let receivedConfig
    HireFire.configure(config => { receivedConfig = config })
    expect(receivedConfig).toBeInstanceOf(Configuration)
    expect(receivedConfig).toBe(HireFire.configuration)
  })
})
