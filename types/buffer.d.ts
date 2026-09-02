export = Buffer
declare class Buffer {
  sample(name: string, strategy: string, value: number): void
  flush(): Buffer.Snapshot
  discardInherited(): void
  repopulate(name: string, strategy: string, data: Buffer.Series): void
}
declare namespace Buffer {
  type Leaf = number | { sum: number; count: number }
  type Series = { [timestamp: string]: Leaf }
  type Snapshot = { [name: string]: { [strategy: string]: Series } }
}
