import type { Agent } from './agent'

export interface RequestParams {
  method: string
  path: string
  tokens?: string | undefined
  start?: string | undefined
}

export interface ResponseParams {
  headers: { [key: string]: string }
  status: number
  body: string
}

export type Next = null

export type ResponseType = ResponseParams | Next

export async function handle (
  agent: Agent,
  params: RequestParams
): Promise<ResponseType> {
  if (params.method === 'GET' && params.path === '/autoscale') {
    return await serve(agent, params)
  }

  recordQueueTime(agent, params)

  return null
}

async function serve (
  agent: Agent,
  params: RequestParams
): Promise<ResponseParams> {
  const tokens = (params.tokens ?? '').split(',')
  const server = agent.workerServers.find(tokens)

  if (server == null) {
    return {
      headers: {},
      status: 404,
      body: "can't find token-associated worker server"
    }
  }

  const body = JSON.stringify(await server.serve())

  return {
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': String(Buffer.byteLength(body, 'utf-8')),
      'Cache-Control': 'must-revalidate, private, max-age=0'
    },
    status: 200,
    body
  }
}

function recordQueueTime (agent: Agent, params: RequestParams): void {
  const dispatcher = agent.webDispatcher

  if (dispatcher == null || params.start == null) {
    return
  }

  const start = parseInt(params.start)

  if (isNaN(start)) {
    return
  }

  const elapsed = Date.now() - ms(agent, start)

  if (elapsed > 0) {
    dispatcher.add(elapsed)
  } else {
    dispatcher.add(0)
  }
}

function ms (agent: Agent, start: number): number {
  switch (agent.platform) {
    case 'render':
      return Math.round(start / 1000)
    default:
      throw new Error('platform is invalid')
  }
}
