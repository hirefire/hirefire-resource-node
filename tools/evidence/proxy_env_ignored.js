"use strict"

const { spawnSync } = require("child_process")
const { boot, sleep, report } = require("./support")

async function main() {
  if (!process.env.TOOLS_PROXY_CHILD) {
    const child = spawnSync(process.execPath, [__filename], {
      env: {
        ...process.env,
        TOOLS_PROXY_CHILD: "1",
        NODE_USE_ENV_PROXY: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        http_proxy: "http://127.0.0.1:9",
      },
      stdio: "inherit",
    })
    process.exitCode = child.status
    return
  }
  const run = await boot({ env: { DYNO: "web.1" } })
  await sleep(2500)
  const ingests = run.ingests().length
  const errors = run.log.filter((line) => line.startsWith("E"))
  await run.stop()
  report(
    "CHECK",
    "with NODE_USE_ENV_PROXY=1 and the proxy variables set to a closed port, the requests still go straight to the data host",
    ingests >= 2 && errors.length === 0,
    [
      `ingest requests in 2.5 seconds: ${ingests}`,
      `error lines: ${errors.length}`,
    ],
  )
}

main()
