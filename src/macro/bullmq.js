const { Queue } = require('bullmq');
const IORedis = require('ioredis');

/**
 * Counts the total number of jobs in the specified queues that are ready for processing or scheduled to run now.
 *
 * @param {string[]} queueNames - An array of queue names.
 * @param {string} [redisURL] - The Redis connection URL.
 * @returns {Promise<number>} The total number of ready or imminently scheduled jobs across all specified queues.
 */
async function jobQueueSize(queueNames, redisURL) {
  redisURL = redisURL || process.env.REDIS_TLS_URL || process.env.REDISURL || 'redis://localhost:6379';
  const redis = new IORedis(redisURL);
  let totalCount = 0;

  try {
    for (const queueName of queueNames) {
      const queue = new Queue(queueName, { connection: redis });

      // Count 'waiting' and 'active' jobs
      const counts = await queue.getJobCounts('wait', 'active');
      totalCount += counts.wait + counts.active;

      // Adjust 'now' to match BullMQ's delayed job timestamp encoding
      const now = Date.now() * 0x1000;

      // Count 'delayed' jobs that are scheduled to run now or in the past
      const delayedCount = await redis.zcount(`bull:${queueName}:delayed`, '-inf', now);
      totalCount += delayedCount;

      // Clean up queue resources
      await queue.close();
    }
  } finally {
    // Ensure Redis connection is closed even if an error occurs
    await redis.quit();
  }

  return totalCount;
}

module.exports = { jobQueueSize };
