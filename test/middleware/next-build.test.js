const fs = require("fs")
const path = require("path")
const { spawnSync } = require("child_process")

const root = path.resolve(__dirname, "..", "..")
const app = path.join(root, "tmp", `next-build-${process.pid}`)
const major = Number(require("next/package.json").version.split(".")[0])

const FILES = {
  "package.json": JSON.stringify({ name: "next-build", private: true }),
  "app/layout.js": `export default function Layout({ children }) {
  return (
    <html>
      <body>{children}</body>
    </html>
  )
}
`,
  "app/page.js": `export const dynamic = "force-dynamic"

export default function Page() {
  return <p>ok</p>
}
`,
  "instrumentation.js": `export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const hirefire = (await import("hirefire-resource")).default
    hirefire.configure(() => {})
  }
}
`,
  "middleware.js": `import { middleware as hirefire } from "hirefire-resource/middleware/next"

export const config = { runtime: "nodejs" }

export function middleware(request) {
  return hirefire(request)
}
`,
  "proxy.js": `import { middleware as hirefire } from "hirefire-resource/middleware/next"

export function proxy(request) {
  return hirefire(request)
}
`,
}

function files(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? files(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    )
}

describe("a Next.js app that uses the middleware", () => {
  beforeAll(() => {
    fs.rmSync(app, { recursive: true, force: true })
    const client = path.join(app, "node_modules", "hirefire-resource")
    fs.mkdirSync(client, { recursive: true })
    for (const entry of ["package.json", "src", "types"]) {
      fs.cpSync(path.join(root, entry), path.join(client, entry), {
        recursive: true,
      })
    }
    const skipped = major >= 16 ? "middleware.js" : "proxy.js"
    for (const [name, text] of Object.entries(FILES)) {
      if (name === skipped) continue
      fs.mkdirSync(path.dirname(path.join(app, name)), { recursive: true })
      fs.writeFileSync(path.join(app, name), text)
    }
  })

  afterAll(() => {
    fs.rmSync(app, { recursive: true, force: true })
  })

  test("builds without pg, bull, bullmq, and pg-boss, and bundles no optional package", () => {
    for (const name of ["pg", "bull", "bullmq", "pg-boss"]) {
      expect(() => require.resolve(name)).toThrow()
    }

    const build = spawnSync(
      process.execPath,
      [require.resolve("next/dist/bin/next"), "build"],
      {
        cwd: app,
        env: { ...process.env, NEXT_TELEMETRY_DISABLED: "1" },
        encoding: "utf8",
      },
    )
    const output = `${build.stdout}\n${build.stderr}`

    expect([build.status, output]).toEqual([0, expect.any(String)])
    expect(output).not.toMatch(
      /Module not found|Can't resolve|Critical dependency|Compiled with warnings/,
    )
    const bundled = files(path.join(app, ".next", "server")).filter(
      (file) =>
        file.endsWith(".js") &&
        fs
          .readFileSync(file, "utf8")
          .includes("Reached the max retries per request limit"),
    )
    expect(bundled).toEqual([])
  }, 300_000)
})
