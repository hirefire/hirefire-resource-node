const http = require("http")
const https = require("https")
const VERSION = require("./version")

const STALE_CONNECTION_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE"])

function isStaleConnectionCode(code) {
  return (
    STALE_CONNECTION_CODES.has(code) ||
    (typeof code === "string" && code.startsWith("HPE_"))
  )
}

/**
 * Raised when a HireFire API request cannot complete successfully.
 *
 * Covers a missing token, transport/timeout failures, 5xx or other unexpected statuses (a 401
 * is treated as "no grant" and does not raise), and failed lease responses.
 */
class RequestError extends Error {
  /**
   * @param {string} message
   */
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
    requestError.retriable =
      Boolean(reusedSocket) && isStaleConnectionCode(error.code)
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
      "The HIREFIRE_TOKEN environment variable is not set.\n" +
        "Set it to your HireFire token to enable metric dispatch.",
    )
  }
}

module.exports = { Client, RequestError }
