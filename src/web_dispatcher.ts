import { dispatch } from './request'
import { debug } from './log'
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

  async add (
    value: number,
    timestamp: string | number = (Date.now() / 1000).toFixed()
  ): Promise<void> {
    await this.mutex.synchronize(async () => {
      timestamp = String(timestamp)
      let next = this.buffer.get(timestamp)

      if (next == null || (value > next)) {
        next = value
      }

      this.buffer.set(timestamp, next)
    })
  }

  async prune (): Promise<void> {
    void this.mutex.synchronize(async () => {
      const retained: Buffer = new Map()
      const maxAge = Math.round(Date.now() / 1000) - this.ttl

      for (const [timestamp, values] of this.buffer) {
        if (parseInt(timestamp) > maxAge) {
          retained.set(timestamp, values)
        }
      }

      debug(`WebDispatcher[${this.id}] buffer:`, this.buffer)
      debug(`WebDispatcher[${this.id}] retain:`, retained)

      this.buffer = retained
    })
  }

  async dispatch (): Promise<void> {
    const payload = await this.buildPayload()

    if (payload.keys().next().done === true) {
      return
    }

    const body = JSON.stringify(Object.fromEntries(payload))

    try {
      debug(await dispatch(body, this.token))
      await this.dispatch()
    } catch (err) {
      await this.revertPayload(payload)
      console.log(`WebDispatcher[${this.id}]: Failed to dispatch`)
      debug(`WebDispatcher[${this.id}]:`, err)
    }
  }

  async buildPayload (): Promise<Buffer> {
    return await this.mutex.synchronize(async () => {
      const payload = new Map()
      const keys = []
      const now = Math.floor(Date.now() / 1000)

      for (const [timestamp] of this.buffer) {
        if (timestamp !== '' && Number(timestamp) < now) {
          keys.push(timestamp)
        }
      }

      for (const key of keys) {
        const value = this.buffer.get(key)

        if (value != null) {
          payload.set(key, value)
          this.buffer.delete(key)
        }
      }

      return payload
    })
  }

  async revertPayload (payload: Buffer): Promise<void> {
    for (const [timestamp, values] of payload) {
      await this.add(values, timestamp)
    }
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
      await this.prune()
    } catch (err) {
      console.log(
        'Unexpected exception occurred in WebDispatchers#prune():',
        err
      )
    }

    try {
      await this.dispatch()
    } catch (err) {
      console.log(
        'Unexpected exception occurred in WebDispatchers#dispatch():',
        err
      )
    }

    setTimeout(() => {
      void this.runLoop()
    }, this.interval)
  }
}
