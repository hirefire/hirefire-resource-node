const http = require("http")
const https = require("https")
const VERSION = require("./version")

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
  }

  // Takes the JSON-encoded body; the dispatcher encodes it to enforce the
  // payload size limit before submitting.
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

  // Returns the raw { statusCode, headers } so the Lease can interpret the
  // grant the same way the Ruby reference reads the Net::HTTP response.
  async requestLease(processId) {
    this._requireToken()

    return this._execute("/metrics/lease", {
      "HireFire-Token": this._token(),
      "HireFire-Process-ID": processId,
    })
  }

  // Maps the whole transport failure family (DNS, refused/reset connections,
  // broken pipes, TLS) and timeouts to RequestError so callers handle one
  // error type. Resolves for any HTTP response (the caller interprets status).
  _execute(path, headers, body) {
    const uri = new URL(this._baseUrl() + path)
    const transport = uri.protocol === "https:" ? https : http
    const options = {
      method: "POST",
      hostname: uri.hostname,
      port: uri.port || (uri.protocol === "https:" ? 443 : 80),
      path: uri.pathname + uri.search,
      headers: { ...headers },
      timeout: this._timeout * 1000,
    }

    if (body !== undefined) {
      options.headers["Content-Length"] = Buffer.byteLength(body)
    }

    return new Promise((resolve, reject) => {
      const request = transport.request(options, (response) => {
        response.resume() // discard the body; only status + headers matter
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode,
            headers: response.headers,
          })
        })
        response.on("error", (error) => reject(this._transportError(error)))
      })

      request.on("timeout", () => {
        request.destroy()
        reject(new RequestError("Request timed out."))
      })

      request.on("error", (error) => reject(this._transportError(error)))

      if (body !== undefined) request.write(body)
      request.end()
    })
  }

  _transportError(error) {
    if (error.code === "ETIMEDOUT" || error.code === "ESOCKETTIMEDOUT") {
      return new RequestError("Request timed out.")
    }
    return new RequestError(
      `Network error (${error.code || error.name}: ${error.message}).`,
    )
  }

  _baseUrl() {
    return process.env.HIREFIRE_DATA_URL || "https://data.hirefire.io"
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
