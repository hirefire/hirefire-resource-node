/* global describe, expect, test */

const Resource = require('../src/resource')
const { Configuration } = require('../src/configuration')

describe('Resource', () => {
  test('configure yields configuration', () => {
    let receivedConfig
    Resource.configure(config => {
      receivedConfig = config
    })
    expect(receivedConfig).toBeInstanceOf(Configuration)
    expect(receivedConfig).toBe(Resource.configuration)
  })
})
