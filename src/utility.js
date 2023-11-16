/**
 * Unpacks the arguments provided to the jobQueueLatency and jobQueueSize functions.
 * This function processes the arguments array and separates queues from options.
 *
 * @param {Array} args - An array of arguments passed to jobQueueLatency or jobQueueSize. This array
 *                       can include queues (as strings or arrays) and an optional options object.
 * @returns {{queues: Array, options: object}} An object containing two properties: `queues`, an
 *                                             array of queues, and `options`, an options object. If
 *                                             no options object is provided in `args`, `options`
 *                                             will be an empty object.
 */
function unpack (args) {
  const lastArg = args[args.length - 1]
  let queues = []
  let options = {}

  if (typeof lastArg === 'object' && lastArg !== null && !Array.isArray(lastArg)) {
    queues = args.slice(0, -1)
    options = lastArg
  } else {
    queues = args
  }

  queues = queues.flat()

  return { queues, options }
}

module.exports = { unpack }
