const pkg = require("../package.json")

describe("TypeScript packaging", () => {
  test("typesVersions maps the hyphenated pg-boss subpath", () => {
    expect(pkg.typesVersions["*"]["macro/pg-boss"]).toEqual([
      "./types/macro/pg_boss.d.ts",
    ])
  })
})
