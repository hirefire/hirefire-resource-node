export = JobQueues
declare class JobQueues implements Iterable<JobQueue> {
  add(jobQueue: JobQueue): void
  any(): boolean
  findByName(name: string): JobQueue | null
  sampleJobQueue(
    jobQueue: JobQueue | null | undefined,
    strategy: string,
    options?: { live?: () => boolean; name?: string },
  ): Promise<void>
  [Symbol.iterator](): IterableIterator<JobQueue>
}
import JobQueue = require("./jobQueue")
