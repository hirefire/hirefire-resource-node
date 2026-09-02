import HireFire = require("../../types")
import Configuration = require("../../types/configuration")
import errors = require("../../types/errors")

const configuration = HireFire.configuration
const httpName: string | null = configuration.httpName
const httpSource = configuration.httpSource
void httpName
void Configuration.MAX_NAME_BYTES
void errors.jobQueueLatencyUnsupported
void errors.MissingQueueError
void errors.JobQueueLatencyUnsupportedError

void configuration.dispatcher.start()
void configuration.dispatcher.stop({ flush: false })
void configuration.dispatcher.stop()
void configuration.dispatcher.running()
void configuration.dispatcher.ensureJobQueueLoop()

void configuration.buffer.sample("web", "rqt", 1)
const snapshot = configuration.buffer.flush()
void snapshot
void configuration.buffer.discardInherited()
void configuration.buffer.repopulate("web", "rqt", {
  "1": { sum: 1, count: 1 },
})

void configuration.jobQueues.any()
void configuration.jobQueues.findByName("worker")
for (const queue of configuration.jobQueues) {
  void queue.name
  void queue.sample()
}

if (httpSource) {
  void httpSource.name
  httpSource.sample(1)
}

for (const cpu of configuration.activeCpuSources()) {
  void cpu.name
  cpu.sample()
}

if (configuration.http) {
  void configuration.http.name
  configuration.http.sample(1)
}
