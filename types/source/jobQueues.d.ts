export = JobQueues
declare class JobQueues implements Iterable<JobQueue> {
  add(jobQueue: JobQueue): void
  any(): boolean
  findByName(name: string): JobQueue | null
  [Symbol.iterator](): IterableIterator<JobQueue>
}
import JobQueue = require("./jobQueue")
