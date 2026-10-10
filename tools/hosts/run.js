"use strict"

const { spawn, spawnSync } = require("child_process")
const fs = require("fs")
const http = require("http")
const ServerProcess = require("./lib/server_process")

const only = process.env.HOST_ONLY ? new RegExp(process.env.HOST_ONLY) : null
const REDIS_URL = process.env.REDIS_URL
const PLAN = {
  job_queues: [
    { name: "worker", strategy: "jqs", adapter: "bullmq", queues: ["default"] },
  ],
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function get(port) {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/",
        headers: { "X-Request-Start": String(Date.now() - 7) },
      },
      (response) => {
        response.resume()
        response.on("end", () => resolve(response.statusCode))
      },
    )
    request.on("error", (error) => resolve(error.code || error.message))
  })
}

function summarize(requests) {
  const senders = {}
  const leaseIds = new Set()
  for (const request of requests) {
    if (request.path === "/metrics/lease") {
      const id = request.headers.find(
        ([name]) => name.toLowerCase() === "hirefire-process-id",
      )
      if (id) leaseIds.add(id[1])
      continue
    }
    const sender = (senders[request.port] = senders[request.port] || {
      ingest: 0,
      names: new Set(),
      rqt_samples: 0,
      rqt_empty_seconds: 0,
      cpu_seconds: 0,
      job_seconds: 0,
    })
    sender.ingest += 1
    let payload = []
    try {
      payload = JSON.parse(request.body)
    } catch {}
    for (const entry of payload) {
      sender.names.add(entry.name)
      const metrics = entry.metrics || {}
      for (const leaf of Object.values(metrics.rqt || {})) {
        if (leaf.length === 2) sender.rqt_samples += leaf[1]
        else sender.rqt_empty_seconds += 1
      }
      sender.cpu_seconds += Object.keys(metrics.cpu || {}).length
      for (const key of ["jqs", "jql", "wrk"]) {
        sender.job_seconds += Object.keys(metrics[key] || {}).length
      }
    }
  }
  return {
    ingest_requests: requests.filter((r) => r.path === "/metrics/ingest")
      .length,
    lease_requests: requests.filter((r) => r.path === "/metrics/lease").length,
    lease_process_ids: leaseIds.size,
    sending_connections: Object.values(senders).map((sender) => ({
      ...sender,
      names: [...sender.names],
    })),
  }
}

async function scenario(spec) {
  const server = await ServerProcess.start()
  await server.plan(spec.plan || { job_queues: [] }, 1)
  const port = 4100 + Math.floor(Math.random() * 800)
  const output = []
  const started = Date.now()
  const command = spec.command.map((part) =>
    part === "PORT_PLACEHOLDER" ? String(port) : part,
  )
  const child = spawn(command[0], command.slice(1), {
    cwd: spec.cwd || "/app",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      HIREFIRE_TOKEN: "host-token",
      HIREFIRE_DATA_URL: server.url,
      PORT: String(port),
      NODE_OPTIONS: "--trace-warnings",
      ...spec.env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  child.stdout.on("data", (chunk) => output.push(String(chunk)))
  child.stderr.on("data", (chunk) => output.push(String(chunk)))
  let exit = null
  child.on("exit", (code, signal) => {
    exit = { code, signal, at: Date.now() }
  })

  const result = { name: spec.name }
  if (spec.idle) {
    const deadline = Date.now() + 15000
    while (!exit && Date.now() < deadline) await sleep(100)
    result.exits_by_itself = Boolean(exit)
    result.exit_after_ms = exit ? exit.at - started : null
    result.exit_code = exit ? exit.code : null
    if (!exit) child.kill("SIGKILL")
  } else {
    await sleep(spec.boot || 3000)
    const statuses = {}
    if (spec.requests) {
      for (let index = 0; index < 20; index += 1) {
        const status = await get(port)
        statuses[status] = (statuses[status] || 0) + 1
        await sleep(50)
      }
      result.app_responses = statuses
    }
    await sleep(6000)
    const before = await server.requests(0, true)
    Object.assign(result, summarize(before))
    const signalAt = Date.now()
    child.kill("SIGTERM")
    const deadline = Date.now() + 12000
    while (!exit && Date.now() < deadline) await sleep(50)
    await sleep(500)
    const after = (await server.requests(signalAt, true)).filter(
      (request) => request.at > signalAt,
    )
    result.sigterm = {
      exited: Boolean(exit),
      exit_after_ms: exit ? exit.at - signalAt : null,
      code: exit ? exit.code : null,
      signal: exit ? exit.signal : null,
      ingest_requests_after_signal: after.filter(
        (request) => request.path === "/metrics/ingest",
      ).length,
    }
    if (!exit) child.kill("SIGKILL")
    spawnSync("pkill", ["-9", "-f", "apps/"])
    spawnSync("pkill", ["-9", "-f", "next"])
  }
  const text = output.join("")
  result.processes = (text.match(/\[host\] pid=\d+[^\n"]*/g) || []).map(
    (line) => line.replace(/pid=\d+/, "pid=N"),
  )
  result.warnings = text
    .split("\n")
    .filter((line) => /warn|deprecat|error|unhandled|not supported/i.test(line))
    .map((line) => line.trim().slice(0, 240))
    .slice(0, 12)
  result.hirefire_lines = [
    ...new Set(
      text
        .split("\n")
        .filter((line) => line.includes("[HireFire]"))
        .map((line) => line.replace(/\d+/g, "N").trim().slice(0, 200)),
    ),
  ].slice(0, 8)
  await server.stop()
  return result
}

function build(major) {
  const run = spawnSync("npx", ["next", "build"], {
    cwd: `/next${major}`,
    encoding: "utf8",
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
  })
  const text = `${run.stdout}\n${run.stderr}`
  return {
    name: `next-${major}-build`,
    exit_code: run.status,
    lines: text
      .split("\n")
      .filter((line) =>
        /error|warn|not supported|edge|middleware|proxy|module not found|can't resolve/i.test(
          line,
        ),
      )
      .map((line) => line.trim().slice(0, 260))
      .slice(0, 16),
  }
}

async function main() {
  const web = { DYNO: "web.1" }
  const specs = []
  for (const kind of ["http", "connect", "express", "koa", "fastify"]) {
    specs.push({
      name: `${kind}-alone`,
      command: ["node", "apps/app.js"],
      env: { ...web, HOST_KIND: kind },
      requests: true,
    })
    specs.push({
      name: `${kind}-cluster`,
      command: ["node", "apps/app.js"],
      env: { ...web, HOST_KIND: kind, HOST_CLUSTER: "1" },
      requests: true,
    })
  }
  specs.push({
    name: "pm2-cluster-express",
    command: ["npx", "pm2-runtime", "start", "apps/app.js", "-i", "2"],
    env: { ...web, HOST_KIND: "express", PM2_HOME: "/tmp/pm2" },
    requests: true,
    boot: 7000,
  })
  specs.push({
    name: "watt-express",
    command: ["/app/node_modules/.bin/wattpm", "start"],
    cwd: "/app/watt",
    env: web,
    requests: true,
    boot: 8000,
  })
  specs.push({
    name: "worker-threads",
    command: ["node", "apps/threads.js"],
    env: { DYNO: "worker.1" },
    plan: { job_queues: [{ name: "worker", strategy: "jqs" }] },
  })
  specs.push({
    name: "bullmq-worker",
    command: ["node", "apps/bullmq_worker.js"],
    env: { DYNO: "worker.1", REDIS_URL, HOST_WORK: "1" },
    plan: PLAN,
  })
  specs.push({
    name: "bullmq-web-that-only-has-the-package",
    command: ["node", "apps/app.js"],
    env: { ...web, HOST_KIND: "express", REDIS_URL },
    requests: true,
    plan: PLAN,
  })
  specs.push({
    name: "idle-no-sampler",
    command: ["node", "apps/idle.js"],
    env: { DYNO: "worker.1" },
    idle: true,
  })
  specs.push({
    name: "idle-with-sampler",
    command: ["node", "apps/idle.js"],
    env: { DYNO: "worker.1", HOST_SAMPLER: "1" },
    idle: true,
    plan: { job_queues: [{ name: "worker", strategy: "jqs" }] },
  })
  specs.push({
    name: "one-off-dyno",
    command: ["node", "apps/app.js"],
    env: { DYNO: "run.1234", HOST_KIND: "none", HOST_SAMPLER: "1" },
    idle: true,
  })

  const results = []
  for (const spec of specs) {
    if (only && !only.test(spec.name)) continue
    results.push(await scenario(spec))
    console.error(`done ${spec.name}`)
  }

  if (!only || only.test("load")) {
    const esm = spawnSync("node", ["apps/esm.mjs"], { encoding: "utf8" })
    results.push({
      name: "load-import",
      exit_code: esm.status,
      output: (esm.stdout + esm.stderr).trim().slice(0, 1500),
    })
    const subpaths = Object.keys(
      require("hirefire-resource/package.json").exports,
    ).filter((key) => key !== "./package.json" && key !== "./middleware/next")
    const loads = {}
    for (const subpath of subpaths) {
      const name = `hirefire-resource${subpath.slice(1)}`
      const cjs = spawnSync(
        "node",
        [
          "--throw-deprecation",
          "--trace-warnings",
          "-e",
          `require(${JSON.stringify(name)})`,
        ],
        { encoding: "utf8" },
      )
      const mjs = spawnSync(
        "node",
        [
          "--throw-deprecation",
          "--trace-warnings",
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(name)})`,
        ],
        { encoding: "utf8" },
      )
      loads[subpath] = {
        require:
          cjs.status === 0 && !cjs.stderr
            ? "ok"
            : cjs.stderr.trim().slice(0, 200),
        import:
          mjs.status === 0 && !mjs.stderr
            ? "ok"
            : mjs.stderr.trim().slice(0, 200),
      }
    }
    results.push({ name: "load-every-subpath", loads })
  }

  for (const major of (process.env.NEXT_MAJORS || "15 16").split(" ")) {
    if (only && !only.test(`next-${major}`)) continue
    const built = build(major)
    results.push(built)
    console.error(`done next-${major}-build`)
    if (built.exit_code !== 0) continue
    results.push(
      await scenario({
        name: `next-${major}-start`,
        command: ["npx", "next", "start", "-p", "PORT_PLACEHOLDER"],
        cwd: `/next${major}`,
        env: { ...web, NEXT_TELEMETRY_DISABLED: "1" },
        requests: true,
        boot: 6000,
        next: true,
      }),
    )
    console.error(`done next-${major}-start`)
  }

  fs.writeFileSync("/out/hosts.json", JSON.stringify(results, null, 2) + "\n")
  process.exit(0)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
