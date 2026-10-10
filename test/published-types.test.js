const fs = require("fs")
const path = require("path")
const ts = require("typescript")
const pkg = require("../package.json")
const Configuration = require("../src/configuration")

const root = path.resolve(__dirname, "..")
const BANNED_NAMES = ["service", "tracking", "Web", "Worker", "Workers"]
const INTERNAL = {
  "./configuration": [
    "activeCpuSources",
    "buffer",
    "dispatcher",
    "httpName",
    "httpSource",
    "jobQueues",
    "markHttpActive",
    "rqtEnabled",
  ],
}

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
    ({ subpath, types, js }) => {
      const internal = INTERNAL[subpath] ?? []
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
        const members = jsInstanceMembers(new mod())
        expect(members).toEqual(expect.arrayContaining(internal))
        assertSameNames(
          `${js} instance`,
          members.filter((name) => !internal.includes(name)),
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

test("the type files declare nothing beside the published modules", () => {
  const published = new Set(publishedModules().map((mod) => mod.types))
  published.add(path.join(root, "types", "hirefire.d.ts"))

  expect(dtsFiles.filter((file) => !published.has(file))).toEqual([])
})
