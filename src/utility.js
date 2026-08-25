const { MissingQueueError } = require("./errors")

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
 * @param {{allowEmpty: boolean}} opts
 * @returns {string[]}
 * @throws {MissingQueueError} when empty and allowEmpty is false
 */
function normalizeQueues(queues, { allowEmpty }) {
  const names = new Set()
  for (const queue of queues) {
    const name = queue == null ? "" : String(queue).trim()
    if (name) names.add(name)
  }
  if (names.size > 0) {
    return Array.from(names)
  }
  if (allowEmpty) {
    return []
  }
  throw new MissingQueueError(
    "No queue was specified. Please specify at least one queue.",
  )
}

module.exports = { unpack, normalizeQueues }
