const http = require("http")
const https = require("https")
const VERSION = require("./version")

const STALE_CONNECTION_CODES = new Set(["ECONNRESET", "ECONNABORTED", "EPIPE"])
const MAX_LEASE_BODY_BYTES = 16384

function isStaleConnectionCode(code) {
  return (
    STALE_CONNECTION_CODES.has(code) ||
    (typeof code === "string" && code.startsWith("HPE_"))
  )
}

/**
 * Raised when a HireFire API request cannot complete successfully.
 *
 * Covers a missing token, transport/timeout failures, 5xx or other unexpected statuses.
 * A 401 is treated as "no grant" and returns null (does not raise). A 413 returns
 * "payload_too_large" (does not raise). Failed lease responses raise.
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
    /** @type {Set<Promise<unknown>>} */
    this._pending = new Set()
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
      { readBody: false },
    )

    const status = response.statusCode
    if (status >= 200 && status < 300) {
      return response
    } else if (status === 401) {
      return null
    } else if (status === 413) {
      return "payload_too_large"
    } else if (status >= 500) {
      throw new RequestError(`Server responded with ${status} status.`)
    } else {
      throw new RequestError(`Unexpected response code ${status}.`)
    }
  }

  async requestLease(processId) {
    this._requireToken()

    return this._execute(
      "/metrics/lease",
      {
        "HireFire-Token": this._token(),
        "HireFire-Agent": `Node-${VERSION}`,
        "HireFire-Process-ID": processId,
      },
      undefined,
      { readBody: true, maxBodyBytes: MAX_LEASE_BODY_BYTES },
    )
  }

  /**
   * Wait for in-flight requests (bounded), then destroy the keep-alive agent.
   * Mid-request-safe close: do not tear down sockets while a POST may still complete.
   *
   * @returns {Promise<void>}
   */
  async close() {
    const pending = [...this._pending]
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 5000)
          if (timer.unref) timer.unref()
        }),
      ])
    }
    if (this._agent) {
      try {
        this._agent.destroy()
      } catch {
        // Swallow close failures so stop paths remain safe.
      }
      this._agent = null
    }
  }

  async _execute(path, headers, body, options = {}) {
    const run = this._executeUntracked(path, headers, body, options)
    this._pending.add(run)
    try {
      return await run
    } finally {
      this._pending.delete(run)
    }
  }

  async _executeUntracked(path, headers, body, options = {}) {
    const uri = new URL(this._baseUrl() + path)
    const transport = uri.protocol === "https:" ? https : http
    const requestOptions = {
      method: "POST",
      hostname: uri.hostname,
      port: uri.port || (uri.protocol === "https:" ? 443 : 80),
      path: uri.pathname + uri.search,
      headers: { ...headers },
      timeout: this._timeout * 1000,
      agent: this._agentFor(transport),
    }

    if (body !== undefined) {
      requestOptions.headers["Content-Length"] = Buffer.byteLength(body)
    }

    try {
      return await this._attempt(transport, requestOptions, body, options)
    } catch (error) {
      if (error instanceof RequestError && error.retriable) {
        return this._attempt(transport, requestOptions, body, options)
      }
      throw error
    }
  }

  _attempt(transport, options, body, readOptions) {
    return new Promise((resolve, reject) => {
      let settled = false
      const settle = (fn, value) => {
        if (settled) return
        settled = true
        fn(value)
      }

      const request = transport.request(options, (response) => {
        if (readOptions.readBody) {
          this._readBody(response, readOptions.maxBodyBytes)
            .then((bodyText) => {
              settle(resolve, {
                statusCode: response.statusCode,
                headers: response.headers,
                body: bodyText,
              })
            })
            .catch((error) =>
              settle(reject, this._transportError(error, request.reusedSocket)),
            )
        } else {
          response.resume()
          response.on("end", () => {
            settle(resolve, {
              statusCode: response.statusCode,
              headers: response.headers,
              body: "",
            })
          })
          response.on("error", (error) =>
            settle(reject, this._transportError(error, request.reusedSocket)),
          )
        }
      })

      request.on("timeout", () => {
        // Settle with a non-retriable timeout first. destroy() can emit error
        // (often ECONNRESET on a reused socket), which must not win the race
        // and trigger a keep-alive retry of a real timeout.
        settle(reject, new RequestError("Request timed out."))
        request.destroy()
      })

      request.on("error", (error) =>
        settle(reject, this._transportError(error, request.reusedSocket)),
      )

      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  _readBody(response, maxBodyBytes) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      let exceeded = false

      response.on("data", (chunk) => {
        if (exceeded) return
        size += chunk.length
        if (size > maxBodyBytes) {
          exceeded = true
          chunks.length = 0
          response.resume()
          return
        }
        chunks.push(chunk)
      })

      response.on("end", () => {
        if (exceeded) {
          // Body exceeded cap: return oversized string so lease parse treats as ignored plan.
          resolve("x".repeat(maxBodyBytes + 1))
          return
        }
        resolve(Buffer.concat(chunks).toString("utf8"))
      })

      response.on("error", reject)
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
    const raw = process.env.HIREFIRE_DATA_URL || "https://data.hirefire.io"
    let stripped = String(raw).trim().replace(/\/+$/, "")
    if (stripped === "") stripped = "https://data.hirefire.io"
    return stripped
  }

  _token() {
    return this._configuration.token
  }

  _requireToken() {
    if (this._token()) return

    throw new RequestError(
      "HireFire token is not set.\n" +
        "Set HIREFIRE_TOKEN or config.token to enable metric dispatch.",
    )
  }
}

module.exports = { Client, RequestError }
