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

module.exports = { unpack }
