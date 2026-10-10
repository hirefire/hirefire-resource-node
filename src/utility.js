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

function presence(value) {
  if (value == null) return null
  const stripped = String(value).trim()
  return stripped.length > 0 ? stripped : null
}

function normalizeQueues(queues, { allowEmpty }) {
  const names = new Set()
  for (const queue of queues) {
    const name = presence(queue)
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

module.exports = { unpack, presence, normalizeQueues }
