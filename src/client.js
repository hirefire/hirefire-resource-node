const http = require("http")
const https = require("https")
const VERSION = require("./version")

const STALE_CONNECTION_CODES = ["ECONNRESET", "ECONNABORTED", "EPIPE"]
const DEFAULT_URL = "https://data.hirefire.io"
const USER_AGENT = `hirefire-resource-node/${VERSION}`
const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"]

function staleConnection(code) {
  return (
    STALE_CONNECTION_CODES.includes(code) || String(code).startsWith("HPE_")
  )
}

class RequestError extends Error {
  constructor(message) {
    super(message)
    this.name = "RequestError"
  }
}

class Response {
  constructor(status, headers, body) {
    this.status = status
    this.headers = headers
    this.body = body
  }

  get ok() {
    return this.status >= 200 && this.status < 300
  }

  get unauthorized() {
    return this.status === 401
  }

  get tooLarge() {
    return this.status === 413
  }

  integer(name) {
    const text = String(this.headers[name.toLowerCase()]).trim()
    if (!/^\d+$/.test(text)) return null
    const value = Number(text)
    return value > 0 ? value : null
  }
}

class Client {
  static MAX_BODY_BYTES = 131072
  static TIMEOUT = 5

  constructor(configuration) {
    this._configuration = configuration
    this._agents = new Map()
    this._pending = new Set()
  }

  async submitSamples(body) {
    const response = await this._execute(
      "/metrics/ingest",
      { "Content-Type": "application/json", ...this._credentials() },
      body,
      (stream) => this._drain(stream),
    )

    if (response.ok || response.unauthorized || response.tooLarge) {
      return response
    }
    throw new RequestError(
      `Ingest request failed with ${response.status} status.`,
    )
  }

  async requestLease(processId) {
    return this._execute(
      "/metrics/lease",
      { ...this._credentials(), "HireFire-Process-ID": processId },
      undefined,
      (stream) => this._read(stream),
    )
  }

  async close() {
    if (this._pending.size > 0) {
      await Promise.race([
        Promise.allSettled(this._pending),
        new Promise((resolve) => {
          setTimeout(resolve, Client.TIMEOUT * 1000).unref()
        }),
      ])
    }
    for (const agent of this._agents.values()) {
      try {
        agent.destroy()
      } catch {}
    }
  }

  async _execute(path, headers, body, read) {
    const run = this._request(path, headers, body, read)
    this._pending.add(run)
    try {
      return await run
    } finally {
      this._pending.delete(run)
    }
  }

  async _request(path, headers, body, read) {
    const uri = new URL(this._baseUrl() + path)
    const transport = uri.protocol === "https:" ? https : http
    const controller = new AbortController()
    const deadline = setTimeout(
      () => controller.abort(),
      Client.TIMEOUT * 1000,
    ).unref()
    const options = {
      method: "POST",
      hostname: uri.hostname,
      port: uri.port,
      path: uri.pathname + uri.search,
      headers: { "User-Agent": USER_AGENT, ...headers },
      signal: controller.signal,
      agent: this._agentFor(transport),
    }
    if (body !== undefined) {
      options.headers["Content-Length"] = Buffer.byteLength(body)
    }

    try {
      return await this._attempt(transport, options, body, read).catch(
        (error) => {
          if (!error.retriable || controller.signal.aborted) throw error
          return this._attempt(transport, options, body, read)
        },
      )
    } catch (error) {
      throw controller.signal.aborted
        ? new RequestError("Request timed out.")
        : error
    } finally {
      clearTimeout(deadline)
    }
  }

  _attempt(transport, options, body, read) {
    return new Promise((resolve, reject) => {
      const fail = (error) =>
        reject(this._transportError(error, request.reusedSocket))
      const request = transport.request(options, (response) => {
        read(response).then(
          (text) =>
            resolve(new Response(response.statusCode, response.headers, text)),
          fail,
        )
      })
      request.on("error", fail)
      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  _drain(response) {
    return new Promise((resolve, reject) => {
      response.resume()
      response.on("end", () => resolve(""))
      response.on("error", reject)
    })
  }

  _read(response) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      const oversized = () => {
        response.destroy()
        reject(
          new RequestError(
            `Response body exceeded ${Client.MAX_BODY_BYTES} bytes (status ${response.statusCode}).`,
          ),
        )
      }

      if (Number(response.headers["content-length"]) > Client.MAX_BODY_BYTES) {
        oversized()
        return
      }

      response.on("data", (chunk) => {
        size += chunk.length
        if (size > Client.MAX_BODY_BYTES) oversized()
        else chunks.push(chunk)
      })
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
      response.on("error", reject)
    })
  }

  _agentFor(transport) {
    if (!this._agents.has(transport)) {
      this._agents.set(
        transport,
        new transport.Agent({ keepAlive: true, maxSockets: 1 }),
      )
    }
    return this._agents.get(transport)
  }

  _transportError(error, reusedSocket) {
    if (error instanceof RequestError) return error
    if (error.code === "ETIMEDOUT") {
      return new RequestError("Request timed out.")
    }

    const requestError = new RequestError(
      `Network error (${error.code || error.name}: ${error.message}).`,
    )
    requestError.retriable = reusedSocket && staleConnection(error.code)
    return requestError
  }

  _credentials() {
    const token = this._configuration.token
    if (!token) {
      throw new RequestError(
        "HireFire token is not set.\n" +
          "Set HIREFIRE_TOKEN or config.token to enable metric dispatch.",
      )
    }
    return { "HireFire-Token": token, "HireFire-Agent": `Node-${VERSION}` }
  }

  _baseUrl() {
    const url =
      String(process.env.HIREFIRE_DATA_URL ?? "")
        .trim()
        .replace(/\/+$/, "") || DEFAULT_URL
    const uri = URL.canParse(url) ? new URL(url) : null
    if (!uri || !["http:", "https:"].includes(uri.protocol) || !uri.hostname) {
      throw new RequestError(
        "HIREFIRE_DATA_URL must be an http or https URL with a host.",
      )
    }
    if (uri.protocol === "http:" && !LOCAL_HOSTS.includes(uri.hostname)) {
      this._configuration._warnPlainHttpDataUrlOnce(uri.hostname)
    }
    return url
  }
}

module.exports = { Client, RequestError, Response }
