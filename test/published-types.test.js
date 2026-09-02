const fs = require("fs")
const path = require("path")
const ts = require("typescript")
const pkg = require("../package.json")
const Configuration = require("../src/configuration")

const root = path.resolve(__dirname, "..")
const BANNED_NAMES = ["service", "tracking", "Web", "Worker", "Workers"]

function walkDts(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkDts(full))
    else if (entry.name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

function publishedModules() {
  const mods = []
  for (const [subpath, entry] of Object.entries(pkg.exports)) {
    if (!entry || typeof entry !== "object") continue
    if (typeof entry.types !== "string" || typeof entry.default !== "string") {
      continue
    }
    mods.push({
      subpath,
      types: path.resolve(root, entry.types),
      js: path.resolve(root, entry.default),
    })
  }
  return mods
}

function moduleKind(mod) {
  if (typeof mod === "function") {
    const source = Function.prototype.toString.call(mod)
    return /^\s*class\s/.test(source) ? "class" : "function"
  }
  if (mod && typeof mod === "object") {
    const proto = Object.getPrototypeOf(mod)
    if (proto && proto !== Object.prototype && proto.constructor !== Object) {
      return "instance"
    }
    return "named"
  }
  return "other"
}

function jsNamedExports(mod) {
  return Object.keys(mod)
    .filter((name) => !name.startsWith("_"))
    .sort()
}

function jsInstanceMembers(value) {
  const names = new Set()
  let proto = value
  const seen = new Set()
  while (proto && proto !== Object.prototype) {
    if (seen.has(proto)) break
    seen.add(proto)
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== "constructor" && !name.startsWith("_")) names.add(name)
    }
    for (const symbol of Object.getOwnPropertySymbols(proto)) {
      if (symbol === Symbol.iterator) names.add("Symbol.iterator")
    }
    proto = Object.getPrototypeOf(proto)
  }
  return [...names].sort()
}

function propertyName(symbol) {
  const name = symbol.getName()
  if (name.startsWith("__@iterator")) return "Symbol.iterator"
  return name
}

function isValueSymbol(checker, symbol) {
  let resolved = symbol
  if (symbol.flags & ts.SymbolFlags.Alias) {
    try {
      resolved = checker.getAliasedSymbol(symbol)
    } catch {
      resolved = symbol
    }
  }
  return Boolean(resolved.flags & ts.SymbolFlags.Value)
}

function unwrapNullish(type) {
  if (!type.isUnion()) return [type]
  return type.types.filter(
    (part) =>
      !(
        part.flags &
        (ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void)
      ),
  )
}

const dtsFiles = walkDts(path.join(root, "types"))
const program = ts.createProgram(dtsFiles, {
  module: ts.ModuleKind.Node16,
  moduleResolution: ts.ModuleResolutionKind.Node16,
  strict: true,
  skipLibCheck: true,
  noEmit: true,
})
const checker = program.getTypeChecker()

function sourceFile(dtsPath) {
  const sf = program.getSourceFile(dtsPath)
  if (!sf) throw new Error(`missing declaration source: ${dtsPath}`)
  return sf
}

function isExportEquals(sf) {
  return sf.statements.some(
    (stmt) => ts.isExportAssignment(stmt) && stmt.isExportEquals,
  )
}

function dtsNamedValueExports(sf) {
  const moduleSymbol = checker.getSymbolAtLocation(sf)
  if (!moduleSymbol) return []
  return checker
    .getExportsOfModule(moduleSymbol)
    .filter((symbol) => symbol.getName() !== "prototype")
    .filter((symbol) => isValueSymbol(checker, symbol))
    .map((symbol) => symbol.getName())
    .sort()
}

function exportEqualsExpression(sf) {
  const stmt = sf.statements.find(
    (node) => ts.isExportAssignment(node) && node.isExportEquals,
  )
  if (!stmt) throw new Error(`expected export= in ${sf.fileName}`)
  return stmt.expression
}

function dtsConstructorType(sf) {
  const expr = exportEqualsExpression(sf)
  const symbol = checker.getSymbolAtLocation(expr)
  return checker.getTypeOfSymbolAtLocation(symbol, expr)
}

function dtsInstanceType(sf) {
  const ctorType = dtsConstructorType(sf)
  const construct = ctorType.getConstructSignatures()[0]
  if (construct) return construct.getReturnType()
  return checker.getTypeAtLocation(exportEqualsExpression(sf))
}

function dtsMembers(type) {
  return type
    .getProperties()
    .map(propertyName)
    .filter(
      (name) =>
        name !== "constructor" && name !== "prototype" && !name.startsWith("_"),
    )
    .sort()
}

function typeOfProperty(type, name) {
  const symbol = type.getProperty(name)
  if (!symbol)
    throw new Error(`missing property ${name} on ${checker.typeToString(type)}`)
  const declaration = symbol.valueDeclaration || symbol.declarations[0]
  return checker.getTypeOfSymbolAtLocation(symbol, declaration)
}

function returnType(type, methodName) {
  const methodType = typeOfProperty(type, methodName)
  const signature = methodType.getCallSignatures()[0]
  if (!signature) {
    throw new Error(
      `no call signature for ${methodName} on ${checker.typeToString(type)}`,
    )
  }
  return signature.getReturnType()
}

function arrayElementType(type) {
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const args = checker.getTypeArguments(type)
    if (args && args.length > 0) return args[0]
  }
  const index = type.getNumberIndexType()
  if (index) return index
  throw new Error(`not an array type: ${checker.typeToString(type)}`)
}

function assertSameNames(label, jsNames, dtsNames) {
  expect({ label, names: jsNames }).toEqual({ label, names: dtsNames })
}

describe("published declaration export names", () => {
  test.each(publishedModules())(
    "$subpath matches the JS module both ways",
    ({ types, js }) => {
      const mod = require(js)
      const sf = sourceFile(types)
      const kind = moduleKind(mod)

      if (kind === "named") {
        expect(isExportEquals(sf)).toBe(false)
        assertSameNames(js, jsNamedExports(mod), dtsNamedValueExports(sf))
        return
      }

      expect(isExportEquals(sf)).toBe(true)

      if (kind === "class") {
        const jsStatics = jsNamedExports(mod)
        const dtsStatics = dtsMembers(dtsConstructorType(sf))
        assertSameNames(`${js} statics`, jsStatics, dtsStatics)
        const instance = new mod()
        assertSameNames(
          `${js} instance`,
          jsInstanceMembers(instance),
          dtsMembers(dtsInstanceType(sf)),
        )
        return
      }

      if (kind === "instance") {
        assertSameNames(
          js,
          jsInstanceMembers(mod),
          dtsMembers(dtsInstanceType(sf)),
        )
        return
      }

      if (kind === "function") {
        expect(jsNamedExports(mod)).toEqual([])
        expect(dtsNamedValueExports(sf)).toEqual([])
      }
    },
  )

  test("published modules and declarations omit the removed 1.x surface", () => {
    for (const { types, js, subpath } of publishedModules()) {
      const mod = require(js)
      const sf = sourceFile(types)
      const jsNames = new Set([
        ...jsNamedExports(mod),
        ...(typeof mod === "function" &&
        /^\s*class\s/.test(Function.prototype.toString.call(mod))
          ? jsInstanceMembers(new mod())
          : jsInstanceMembers(mod)),
      ])
      const dtsNames = new Set([
        ...dtsNamedValueExports(sf),
        ...(isExportEquals(sf) ? dtsMembers(dtsInstanceType(sf)) : []),
      ])
      for (const name of BANNED_NAMES) {
        expect({ subpath, name, inJs: jsNames.has(name) }).toEqual({
          subpath,
          name,
          inJs: false,
        })
        expect({ subpath, name, inDts: dtsNames.has(name) }).toEqual({
          subpath,
          name,
          inDts: false,
        })
      }
    }
  })
})

describe("Configuration nested collector types", () => {
  const previousDyno = process.env.DYNO

  afterEach(() => {
    if (previousDyno === undefined) delete process.env.DYNO
    else process.env.DYNO = previousDyno
  })

  test("reachable nested members match the handwritten declarations both ways", () => {
    process.env.DYNO = "web.1"
    const config = new Configuration()
    config.logger = { info() {}, warn() {}, error() {} }
    config.dyno("worker", () => 1)

    const sf = sourceFile(path.join(root, "types/configuration.d.ts"))
    const instType = dtsInstanceType(sf)

    assertSameNames(
      "Configuration",
      jsInstanceMembers(config),
      dtsMembers(instType),
    )

    const jobQueuesType = unwrapNullish(
      typeOfProperty(instType, "jobQueues"),
    )[0]
    assertSameNames(
      "jobQueues",
      jsInstanceMembers(config.jobQueues),
      dtsMembers(jobQueuesType),
    )

    const queue = [...config.jobQueues][0]
    const queueType = unwrapNullish(returnType(jobQueuesType, "findByName"))[0]
    assertSameNames("jobQueue", jsInstanceMembers(queue), dtsMembers(queueType))

    const dispatcherType = unwrapNullish(
      typeOfProperty(instType, "dispatcher"),
    )[0]
    assertSameNames(
      "dispatcher",
      jsInstanceMembers(config.dispatcher),
      dtsMembers(dispatcherType),
    )

    const bufferType = unwrapNullish(typeOfProperty(instType, "buffer"))[0]
    assertSameNames(
      "buffer",
      jsInstanceMembers(config.buffer),
      dtsMembers(bufferType),
    )

    const httpSource = config.httpSource
    expect(httpSource).not.toBeNull()
    const httpType = unwrapNullish(typeOfProperty(instType, "httpSource"))[0]
    assertSameNames(
      "httpSource",
      jsInstanceMembers(httpSource),
      dtsMembers(httpType),
    )

    const httpFieldType = unwrapNullish(typeOfProperty(instType, "http"))[0]
    assertSameNames("http", dtsMembers(httpFieldType), dtsMembers(httpType))

    const cpu = config.activeCpuSources()[0]
    expect(cpu).toBeDefined()
    const cpuType = unwrapNullish(
      arrayElementType(returnType(instType, "activeCpuSources")),
    )[0]
    assertSameNames("cpu", jsInstanceMembers(cpu), dtsMembers(cpuType))
  })
})
