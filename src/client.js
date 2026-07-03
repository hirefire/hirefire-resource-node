const http = require("http")
const https = require("https")
const VERSION = require("./version")

// A reused keep-alive socket the peer dropped while idle fails with one of these on the
// next write. Retrying on a fresh socket is safe: both endpoints are idempotent.
const STALE_CONNECTION_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE"])

class RequestError extends Error {
  constructor(message) {
    super(message)
    this.name = "RequestError"
  }
}

class Client {
  constructor(configuration, { timeout = 5 } = {}) {
    this._configuration = configuration
    this._timeout = timeout
    this._agent = null
  }

  async submitSamples(body) {
    this._requireToken()

    const response = await this._execute(
      "/metrics/ingest",
      {
        "Content-Type": "application/json",
        "HireFire-Token": this._token(),
        "HireFire-Agent": `Node-${VERSION}`,
      },
      body,
    )

    const status = response.statusCode
    if (status >= 200 && status < 300) {
      return response
    } else if (status === 401) {
      return null
    } else if (status >= 500) {
      throw new RequestError(`Server responded with ${status} status.`)
    } else {
      throw new RequestError(`Unexpected response code ${status}.`)
    }
  }

  async requestLease(processId) {
    this._requireToken()

    return this._execute("/metrics/lease", {
      "HireFire-Token": this._token(),
      "HireFire-Agent": `Node-${VERSION}`,
      "HireFire-Process-ID": processId,
    })
  }

  close() {
    if (this._agent) {
      this._agent.destroy()
      this._agent = null
    }
  }

  async _execute(path, headers, body) {
    const uri = new URL(this._baseUrl() + path)
    const transport = uri.protocol === "https:" ? https : http
    const options = {
      method: "POST",
      hostname: uri.hostname,
      port: uri.port || (uri.protocol === "https:" ? 443 : 80),
      path: uri.pathname + uri.search,
      headers: { ...headers },
      timeout: this._timeout * 1000,
      agent: this._agentFor(transport),
    }

    if (body !== undefined) {
      options.headers["Content-Length"] = Buffer.byteLength(body)
    }

    try {
      return await this._attempt(transport, options, body)
    } catch (error) {
      if (error instanceof RequestError && error.retriable) {
        return this._attempt(transport, options, body)
      }
      throw error
    }
  }

  _attempt(transport, options, body) {
    return new Promise((resolve, reject) => {
      const request = transport.request(options, (response) => {
        response.resume()
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
          })
        })
        response.on("error", (error) =>
          reject(this._transportError(error, request.reusedSocket)),
        )
      })

      request.on("timeout", () => {
        request.destroy()
        reject(new RequestError("Request timed out."))
      })

      request.on("error", (error) =>
        reject(this._transportError(error, request.reusedSocket)),
      )

      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  // A dedicated keep-alive agent per client, not Node's shared global agent, so reuse is
  // guaranteed and isolated from app traffic. Idle sockets are never evicted on a timer, so
  // a peer-dropped socket is recovered by the retry in _execute, not a client-side timeout.
  _agentFor(transport) {
    if (!this._agent) {
      this._agent = new transport.Agent({
        keepAlive: true,
        maxSockets: 1,
        maxFreeSockets: 1,
      })
    }
    return this._agent
  }

  _transportError(error, reusedSocket = false) {
    if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT") {
      return new RequestError("Request timed out.")
    }
    const requestError = new RequestError(
      `Network error (${error.code || error.name}: ${error.message}).`,
    )
    // Retry only a reused socket: a fresh connection failing is a real fault, not staleness.
    requestError.retriable =
      Boolean(reusedSocket) && STALE_CONNECTION_CODES.has(error.code)
    return requestError
  }

  _baseUrl() {
    const url = process.env.HIREFIRE_DATA_URL || "https://data.hirefire.io"
    return url.replace(/\/+$/, "")
  }

  _token() {
    return this._configuration.token
  }

  _requireToken() {
    if (this._token()) return

    throw new RequestError(
      "The HIREFIRE_TOKEN environment variable is not set. " +
        "Set it to your HireFire token to enable metric dispatch.",
    )
  }
}

module.exports = { Client, RequestError }
