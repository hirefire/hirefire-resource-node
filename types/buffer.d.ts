export = Buffer
declare class Buffer {
  sample(name: string, strategy: string, value: number): void
  flush(): object
  discardInherited(): void
  repopulate(name: string, strategy: string, data: object): void
}
