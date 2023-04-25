import { dispatch } from './request'
import { Mutex } from './mutex'

type Buffer = Map<string, number>

export class WebDispatcher {
  readonly id: string
  readonly token: string
  private buffer: Buffer = new Map()
  private readonly ttl = 30
  private readonly interval = 15_000
  private running: boolean
  private readonly mutex: Mutex

  constructor (token: string) {
    this.id = token.slice(0, 7)
    this.token = token
    this.running = false
    this.mutex = new Mutex()
  }

  async add (value: number, timestamp: string | number = (Date.now() / 1000).toFixed()): Promise<void> {
    await this.mutex.synchronize(async () => {
      await this.addUnsafe(value, timestamp)
    })
  }

  async run (): Promise<void> {
    await this.mutex.synchronize(async () => {
      if (this.running) {
        return
      }

      this.running = true

      void this.runLoop()
    })
  }

  private async runLoop (): Promise<void> {
    try {
      await this.dispatch()
    } catch (err) {
      console.log(
        'Unexpected exception occurred in WebDispatcher#dispatch():',
        err
      )
    }

    setTimeout(() => {
      void this.runLoop()
    }, this.interval)
  }

  private async addUnsafe (value: number, timestamp: string | number = (Date.now() / 1000).toFixed()): Promise<void> {
    const ts = Number(timestamp)
    const tsString = String(timestamp)
    const now = Date.now() / 1000

    if (ts < now - this.ttl) {
      return
    }

    const existing = this.buffer.get(tsString)

    if (existing === undefined || value > existing) {
      this.buffer.set(tsString, value)
    }
  }

  private async flush (): Promise<Buffer> {
    return await this.mutex.synchronize(async () => {
      const buffer = this.buffer

      this.buffer = new Map()

      return buffer
    })
  }

  private async revert (buffer: Buffer): Promise<void> {
    await this.mutex.synchronize(async () => {
      for (const [timestamp, value] of buffer) {
        await this.addUnsafe(value, timestamp)
      }
    })
  }

  private async dispatch (): Promise<void> {
    const buffer = await this.flush()

    if (buffer.size === 0) {
      return
    }

    const payload = JSON.stringify(Object.fromEntries(buffer))

    try {
      await dispatch(payload, this.token)
    } catch (err) {
      await this.revert(buffer)
      console.log(`WebDispatcher[${this.id}]: Failed to dispatch`)
    }
  }
}
