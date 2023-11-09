export type WorkerFunctionPromise = Promise<number | null>
export type WorkerFunction = () => WorkerFunctionPromise

export class Worker {
  id: string
  token: string
  fn: WorkerFunction

  constructor(token: string, fn: WorkerFunction) {
    this.id = token.slice(0, 7)
    this.token = token
    this.fn = fn
  }

  async serve (): WorkerFunctionPromise {
    return await this.fn()
  }
}


// @TODO necessary? Just array of workers?
// export class Workers {
//   private readonly servers: WorkerServer[] = []

//   push (server: WorkerServer): void {
//     this.servers.push(server)
//   }

//   find (tokens: string[]): WorkerServer | null {
//     for (const server of this.servers) {
//       if (tokens.includes(server.token)) {
//         return server
//       }
//     }

//     return null
//   }
// }
