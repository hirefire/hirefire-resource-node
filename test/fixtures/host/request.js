const { processRequestQueueTime } = require("../../../src/middleware")

processRequestQueueTime(String(Date.now()))
setTimeout(() => {}, 1500)
