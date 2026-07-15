function unpack(args) {
  const lastArg = args[args.length - 1]
  let queues = []
  let options = {}

  if (
    typeof lastArg === "object" &&
    lastArg !== null &&
    !Array.isArray(lastArg)
  ) {
    queues = args.slice(0, -1)
    options = lastArg
  } else {
    queues = args
  }

  queues = queues.flat()

  return { queues, options }
}

/**
 * Trim and de-duplicate queue names into a set, matching the adapter contract.
 *
 * @param {Iterable<string>} queues
 * @returns {string[]}
 */
function normalizeQueues(queues) {
  const names = new Set()
  for (const queue of queues) {
    const name = String(queue).trim()
    if (name) names.add(name)
  }
  return Array.from(names)
}

module.exports = { unpack, normalizeQueues }
