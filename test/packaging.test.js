const fs = require("fs")
const path = require("path")
const pkg = require("../package.json")
const tsconfig = require("../tsconfig.json")

describe("TypeScript packaging", () => {
  test("package.json points consumers at bundled declarations", () => {
    expect(pkg.types).toBe("./types/index.d.ts")
    expect(pkg.files).toEqual(
      expect.arrayContaining([
        "CHANGELOG.md",
        "LICENSE",
        "README.md",
        "src",
        "types",
      ]),
    )
    expect(pkg.scripts["build:types"]).toBe("tsc")
    expect(pkg.scripts.prepack).toBe("npm run build:types")

    for (const [subpath, entry] of Object.entries(pkg.exports)) {
      expect(entry.types).toMatch(/\.d\.ts$/)
      expect(entry.default).toMatch(/\.js$/)
      expect(subpath && entry.types).toBeTruthy()
    }

    expect(pkg.typesVersions["*"]["macro/pg-boss"]).toEqual([
      "./types/macro/pg_boss.d.ts",
    ])
  })

  test("tsconfig emits declarations from JavaScript and does not enable checkJs", () => {
    expect(tsconfig.compilerOptions.allowJs).toBe(true)
    expect(tsconfig.compilerOptions.checkJs).toBe(false)
    expect(tsconfig.compilerOptions.declaration).toBe(true)
    expect(tsconfig.compilerOptions.emitDeclarationOnly).toBe(true)
    expect(tsconfig.compilerOptions.outDir).toBe("types")
  })

  test("public consumer surface has JSDoc type contract", () => {
    const hirefire = fs.readFileSync(
      path.join(__dirname, "../src/hirefire.js"),
      "utf8",
    )
    expect(hirefire).toMatch(/@param \{\(config: Configuration\) => void\} fn/)
    expect(hirefire).toMatch(/@returns \{Configuration\}/)
    expect(hirefire).toMatch(/\bboot\(\)/)

    const configuration = fs.readFileSync(
      path.join(__dirname, "../src/configuration.js"),
      "utf8",
    )
    expect(configuration).toMatch(/@param \{string\} name/)
    expect(configuration).toMatch(/\bdyno\(/)
    expect(configuration).toMatch(/@returns \{void\}/)
  })
})
