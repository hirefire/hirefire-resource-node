// The http collector: represents the HTTP-serving process for request queue
// time tracking. The whole HTTP family (RequestQueueTime, RequestsPerMinute)
// rides this one feed; the server derives queue time from the sample values and
// request rate from the sample counts. The name need not be "web" — on
// Render/DigitalOcean the HTTP process can have any name.
class Web {
  constructor(name, configuration) {
    this._name = String(name)
    this._configuration = configuration
  }

  get name() {
    return this._name
  }

  sample(requestQueueTime) {
    this._configuration.buffer.sampleWeb(requestQueueTime)
  }
}

module.exports = Web
