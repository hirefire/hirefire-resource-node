/**
 * Error thrown when no queues are provided.
 */
class MissingQueueError extends Error {
  constructor () {
    super('No queues were provided.')
    this.name = 'MissingQueueError'
  }
}

module.exports = { MissingQueueError }
