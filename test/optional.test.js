const fs = require("fs")
const os = require("os")
const path = require("path")
const { execFileSync } = require("child_process")
const { load, installed } = require("../src/optional")

const root = path.resolve(__dirname, "..")

describe("optional packages", () => {
  test("a package that the client can resolve is installed and loads", () => {
    expect(installed("nock")).toBe(true)
    expect(load("nock")).toBe(require("nock"))
  })

  test("a package that nothing can resolve is not installed, and loading it fails as a require does", () => {
    expect(installed("hirefire-no-such-package")).toBe(false)
    expect(() => load("hirefire-no-such-package")).toThrow(
      expect.objectContaining({ code: "MODULE_NOT_FOUND" }),
    )
  })

  describe("in an install that keeps each package to its declared dependencies", () => {
    let scratch
    let app

    function fakePackage(directory, name) {
      fs.mkdirSync(directory, { recursive: true })
      fs.writeFileSync(
        path.join(directory, "package.json"),
        JSON.stringify({ name, version: "1.0.0", main: "index.js" }),
      )
      fs.writeFileSync(
        path.join(directory, "index.js"),
        `module.exports = { name: ${JSON.stringify(name)} }\n`,
      )
    }

    function probe(cwd) {
      const script = `
        const path = require("path")
        const home = ${JSON.stringify(path.join(scratch, "store", "client"))}
        const Plan = require(path.join(home, "src", "plan"))
        const { load } = require(path.join(home, "src", "optional"))
        let name = null
        try { name = load("bullmq").name } catch {}
        console.log(JSON.stringify({
          seen: Plan.ADAPTERS.bullmq.libraryLoaded(),
          race: Plan.anyLibraryLoaded(),
          name,
        }))
      `
      return JSON.parse(
        execFileSync(process.execPath, ["-e", script], {
          cwd,
          encoding: "utf8",
        }),
      )
    }

    beforeAll(() => {
      scratch = fs.mkdtempSync(
        path.join(fs.realpathSync(os.tmpdir()), "hirefire-strict-install-"),
      )
      const client = path.join(scratch, "store", "client")
      app = path.join(scratch, "apps", "web")
      fs.mkdirSync(client, { recursive: true })
      fs.cpSync(path.join(root, "src"), path.join(client, "src"), {
        recursive: true,
      })
      fs.copyFileSync(
        path.join(root, "package.json"),
        path.join(client, "package.json"),
      )
      fakePackage(path.join(app, "node_modules", "bullmq"), "bullmq")
      fakePackage(path.join(app, "node_modules", "ioredis"), "ioredis")
      fs.symlinkSync(
        client,
        path.join(app, "node_modules", "hirefire-resource"),
      )
    })

    afterAll(() => {
      fs.rmSync(scratch, { recursive: true, force: true })
    })

    test("a process that runs in the app finds the packages of the app", () => {
      expect(probe(app)).toEqual({ seen: true, race: true, name: "bullmq" })
    })

    test("a process that runs elsewhere does not", () => {
      expect(probe(scratch)).toEqual({ seen: false, race: false, name: null })
    })
  })
})
