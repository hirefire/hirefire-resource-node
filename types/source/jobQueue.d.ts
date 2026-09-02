export = JobQueue
declare class JobQueue {
  get name(): string
  sample(): number | Promise<number>
}
