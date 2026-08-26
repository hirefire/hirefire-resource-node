const fs = require("fs")
const path = require("path")

const root = path.resolve(__dirname, "..")
const matrix = JSON.parse(
  fs.readFileSync(path.join(root, "test", "matrix.json"), "utf8"),
)

function walkTests(dir, rel) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const nextRel = `${rel}/${entry.name}`
    if (entry.isDirectory()) {
      out.push(...walkTests(path.join(dir, entry.name), nextRel))
    } else if (entry.name.endsWith(".test.js")) {
      out.push(nextRel)
    }
  }
  return out
}

function integrationPrefixes() {
  return matrix.integrations
    .filter((entry) => entry.package !== "core")
    .map((entry) => entry.test)
}

function matchesPrefix(file, prefix) {
  return new RegExp(prefix).test(file)
}

test("every test/macro test.js is claimed by an integrations test prefix", () => {
  const files = walkTests(path.join(root, "test", "macro"), "test/macro")
  const prefixes = integrationPrefixes()
  const orphans = files.filter(
    (file) => !prefixes.some((prefix) => matchesPrefix(file, prefix)),
  )
  expect(orphans).toEqual([])
})

test("each test file matches at most one integration prefix", () => {
  const files = walkTests(path.join(root, "test"), "test")
  const prefixes = integrationPrefixes()
  const overlaps = []
  for (const file of files) {
    const hits = prefixes.filter((prefix) => matchesPrefix(file, prefix))
    if (hits.length > 1) overlaps.push({ file, hits })
  }
  expect(overlaps).toEqual([])
})

test("classic bull prefix does not match bullmq tests", () => {
  const bull = matrix.integrations.find(
    (entry) => entry.package === "bull",
  ).test
  const files = walkTests(path.join(root, "test", "macro"), "test/macro")
  const bullmqFiles = files.filter((file) => file.includes("/bullmq"))
  expect(bullmqFiles.length).toBeGreaterThan(0)
  for (const file of bullmqFiles) {
    expect(matchesPrefix(file, bull)).toBe(false)
  }
})

test("test/macro/bull without a trailing slash would overlap bullmq", () => {
  expect(
    matchesPrefix("test/macro/bullmq/bullmq.test.js", "test/macro/bull"),
  ).toBe(true)
  expect(
    matchesPrefix("test/macro/bullmq/bullmq.test.js", "test/macro/bull/"),
  ).toBe(false)
})
