import HireFire = require("../../types")

const configuration = HireFire.configuration
const httpName: string | null = configuration.httpName
const httpSource = configuration.httpSource
void httpName
void httpSource

void configuration.dispatcher.stop({ flush: false })
void configuration.dispatcher.stop()
