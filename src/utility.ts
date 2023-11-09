// Util module?


export class Mutex {
  private locked: boolean = false
  private readonly waiting: Array<() => void> = []

  async lock (): Promise<void> {
    while (this.locked) {
      await new Promise<void>(resolve => this.waiting.push(resolve))
    }
    this.locked = true
  }

  unlock (): void {
    this.locked = false
    const nextResolve = this.waiting.shift()
    nextResolve?.()
  }

  async synchronize<T> (fn: () => Promise<T>): Promise<T> {
    await this.lock()
    try {
      return await fn()
    } finally {
      this.unlock()
    }
  }
}

export function debug (msg?: any, ...args: any[]): void {
  if (process.env['AUTOSCALE_DEBUG'] != null) {
    console.log(msg, ...args)
  }
}
