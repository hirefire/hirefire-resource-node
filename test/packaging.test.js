const { execFileSync } = require("child_process")
const path = require("path")
const pkg = require("../package.json")

describe("TypeScript packaging", () => {
  test("typesVersions maps the hyphenated pg-boss subpath", () => {
    expect(pkg.typesVersions["*"]["macro/pg-boss"]).toEqual([
      "./types/macro/pg_boss.d.ts",
    ])
  })

  test("package files lock src, types, and docs", () => {
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "src",
        "types",
        "README.md",
        "CHANGELOG.md",
        "LICENSE",
      ]),
    )
  })

  test("package metadata exposes changelog and documentation blob URLs", () => {
    expect(pkg.documentation).toBe(
      "https://github.com/hirefire/hirefire-resource-node/blob/master/README.md",
    )
    expect(pkg.changelog).toBe(
      "https://github.com/hirefire/hirefire-resource-node/blob/master/CHANGELOG.md",
    )
    expect(pkg.bugs).toEqual({
      url: "https://github.com/hirefire/hirefire-resource-node/issues",
    })
    expect(pkg.homepage).toBe("https://hirefire.io")
  })

  test("every package that the client loads from the app is an optional peer dependency", () => {
    const Plan = require("../src/plan")
    const loaded = new Set(["next"])
    for (const adapter of Object.values(Plan.ADAPTERS)) {
      for (const name of adapter.packages) loaded.add(name)
    }

    expect(Object.keys(pkg.peerDependencies).sort()).toEqual([...loaded].sort())
    for (const name of loaded) {
      expect(pkg.peerDependenciesMeta[name]).toEqual({ optional: true })
    }
    expect(pkg.dependencies).toBeUndefined()
  })

  test("npm pack does not include test/ or AGENTS.md", () => {
    const output = execFileSync("npm", ["pack", "--dry-run"], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf8",
    })
    expect(output).not.toMatch(/(^|\/)test\//)
    expect(output).not.toMatch(/(^|\/)AGENTS\.md(\s|$)/)
  })
})
