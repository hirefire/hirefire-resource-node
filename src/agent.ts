import { WebDispatchers } from './web_dispatchers'
import { WebDispatcher } from './web_dispatcher'
import { WorkerDispatchers } from './worker_dispatchers'
import { WorkerDispatcher } from './worker_dispatcher'
import { WorkerServers } from './worker_servers'
import { WorkerServer } from './worker_server'
import type { WorkerFunction } from './worker'

type Platform = 'render'

export class Agent {
  readonly platform: Platform
  readonly webDispatchers = new WebDispatchers()
  readonly workerDispatchers = new WorkerDispatchers()
  readonly workerServers = new WorkerServers()

  constructor(platform: string) {
    this.platform = this.validatePlatform(platform)
  }

  dispatch (token: string, fn?: WorkerFunction): Agent {
    if (fn != null) {
      this.dispatchWorker(token, fn)
    } else {
      this.dispatchWeb(token)
    }

    return this
  }

  serve (token: string, fn: WorkerFunction): Agent {
    this.workerServers.push(new WorkerServer(token, fn))

    return this
  }

  private dispatchWeb (token: string): void {
    this.webDispatchers.setQueueTime(new WebDispatcher(token))
  }

  private dispatchWorker (token: string, fn: WorkerFunction): void {
    this.workerDispatchers.push(new WorkerDispatcher(token, fn))
  }

  private validatePlatform (platform: string): Platform {
    switch (platform) {
      case 'render':
        return platform
      default:
        throw new Error(
          `platform "${platform}" is unsupported, ` +
          '"render" is currently the only valid option'
        )
    }
  }
}
