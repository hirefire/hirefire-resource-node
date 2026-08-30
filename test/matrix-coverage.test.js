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

const SIZE_ONLY = new Set(["bullmq", "bull"])

function readmeSection(heading) {
  const readme = fs.readFileSync(path.join(root, "README.md"), "utf8")
  const match = readme.match(
    new RegExp(`\\*\\*${heading}:\\*\\*\\n\\n((?:- .+\\n)+)`),
  )
  if (!match) throw new Error(`missing README section ${heading}`)
  return match[1]
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
}

function normalize(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

function bulletToken(line) {
  const label = line.match(/^(.+?)\s+\d/)
  return normalize(label ? label[1] : line)
}

function matchesPackage(pkg, line) {
  const bullet = bulletToken(line)
  const last = normalize(pkg.split("/").pop())
  const full = normalize(pkg)
  if (bullet === full || bullet === last) return true
  if (!pkg.includes("/") && bullet === `${last}js`) return true
  if (pkg.startsWith("@")) {
    const scope = normalize(pkg.slice(1).split("/")[0])
    return bullet === scope || `${bullet}js` === scope
  }
  return false
}

test("README runtime floor matches engines.node and matrix.node", () => {
  const pkg = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8"),
  )
  const engineFloor = pkg.engines.node.match(/\d+/)[0]
  const matrixFloor = Math.min(...matrix.node)
  expect(String(matrixFloor)).toBe(engineFloor)
  expect(readmeSection("Supported runtimes")).toEqual([
    `Node.js ${engineFloor}+`,
  ])
})

test("every matrix integration is in the README and the README has no extras", () => {
  const bullets = [
    ...readmeSection("Supported web frameworks"),
    ...readmeSection("Supported worker libraries"),
  ]
  const entries = matrix.integrations.filter(
    (entry) => entry.package !== "core",
  )
  const used = new Set()
  for (const entry of entries) {
    const majors = entry.majors.filter((major) => major != null)
    const min = Math.min(...majors)
    const max = Math.max(...majors)
    const line = bullets.find((item) => matchesPackage(entry.package, item))
    expect(line).toBeDefined()
    used.add(line)
    const excluded = matrix.excludes.filter(
      (item) => item.package === entry.package,
    )
    if (excluded.length) {
      expect(line).toMatch(new RegExp(`${min} to ${max}`))
      const blockedNodes = new Set(excluded.map((item) => item.node))
      const requiredNode = Math.min(
        ...matrix.node.filter((node) => !blockedNodes.has(node)),
      )
      const majorsNeedingNewerNode = [
        ...new Set(excluded.map((item) => item.major)),
      ].sort((a, b) => a - b)
      expect(line).toMatch(
        new RegExp(
          `Versions ${majorsNeedingNewerNode.join(
            " and ",
          )} require Node ${requiredNode}\\+`,
        ),
      )
    } else {
      expect(line).toMatch(new RegExp(`${min}\\+`))
    }
    if (SIZE_ONLY.has(entry.package)) {
      expect(line).toMatch(/size only, no job queue latency/)
      expect(line).toMatch(/ioredis/)
    } else {
      expect(line).not.toMatch(/size only/)
    }
  }
  expect([...used].sort()).toEqual([...bullets].sort())
})
