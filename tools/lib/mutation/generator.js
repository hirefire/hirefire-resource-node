"use strict"

const crypto = require("crypto")
const parser = require("@babel/parser")
const traverse = require("@babel/traverse").default

const BOUNDARY = { "<": "<=", "<=": "<", ">": ">=", ">=": ">" }
const NEGATION = {
  "===": "!==",
  "!==": "===",
  "==": "!=",
  "!=": "==",
  "<": ">=",
  ">": "<=",
  "<=": ">",
  ">=": "<",
}
const ARITHMETIC = { "+": "-", "-": "+", "*": "/", "/": "*", "%": "*" }
const LOGICAL = { "&&": "||", "||": "&&" }
const ASSIGNMENT = { "+=": "-=", "-=": "+=" }

function isText(node) {
  return node.type === "StringLiteral" || node.type === "TemplateLiteral"
}

function generate(file, source) {
  const ast = parser.parse(source, { sourceType: "script", ranges: true })
  const mutants = []
  let current = null
  const add = (mutator, node, start, end, replacement) => {
    const original = source.slice(start, end)
    if (original === replacement) return
    const id = crypto
      .createHash("sha1")
      .update(`${file}\0${start}\0${end}\0${replacement}`)
      .digest("hex")
      .slice(0, 10)
    const statement = current && current.getStatementParent()
    mutants.push({
      id,
      file,
      statementLine:
        statement && mutator !== "body"
          ? statement.node.loc.start.line
          : node.loc.start.line,
      line: node.loc.start.line,
      endLine: node.loc.end.line,
      mutator,
      start,
      end,
      original: original.length > 80 ? `${original.slice(0, 77)}...` : original,
      replacement,
    })
  }
  const operator = (path, table, mutator) => {
    const node = path.node
    const replacement = table[node.operator]
    if (!replacement) return
    const from = node.left.end
    const to = node.right.start
    const between = source.slice(from, to)
    const index = between.indexOf(node.operator)
    if (index === -1) return
    add(
      mutator,
      node,
      from + index,
      from + index + node.operator.length,
      replacement,
    )
  }

  traverse(ast, {
    enter(path) {
      current = path
    },
    BinaryExpression(path) {
      const node = path.node
      operator(path, BOUNDARY, "boundary")
      operator(path, NEGATION, "negation")
      if (ARITHMETIC[node.operator]) {
        if (
          node.operator === "+" &&
          (isText(node.left) || isText(node.right))
        ) {
          return
        }
        operator(path, ARITHMETIC, "arithmetic")
      }
    },
    LogicalExpression(path) {
      const node = path.node
      if (node.operator === "??") {
        add("logical", node, node.left.end, node.end, "")
        return
      }
      operator(path, LOGICAL, "logical")
    },
    AssignmentExpression(path) {
      operator(path, ASSIGNMENT, "assignment")
    },
    UpdateExpression(path) {
      const node = path.node
      const replacement = node.operator === "++" ? "--" : "++"
      const text = source.slice(node.start, node.end)
      add(
        "update",
        node,
        node.start,
        node.end,
        text.replace(node.operator, replacement),
      )
    },
    UnaryExpression(path) {
      const node = path.node
      if (node.operator === "!" || node.operator === "-") {
        add(
          "unary",
          node,
          node.start,
          node.end,
          source.slice(node.argument.start, node.argument.end),
        )
      }
    },
    BooleanLiteral(path) {
      const node = path.node
      add("boolean", node, node.start, node.end, String(!node.value))
    },
    NumericLiteral(path) {
      const node = path.node
      if (path.parent.type === "ObjectProperty" && path.parent.key === node) {
        return
      }
      add(
        "number",
        node,
        node.start,
        node.end,
        node.value === 0 ? "1" : String(node.value + 1),
      )
    },
    StringLiteral(path) {
      const node = path.node
      const parent = path.parent
      if (path.parentPath.isDirective && path.parentPath.isDirective()) return
      if (
        parent.type === "CallExpression" &&
        parent.callee.name === "require"
      ) {
        return
      }
      if (parent.type === "ObjectProperty" && parent.key === node) return
      add(
        "string",
        node,
        node.start,
        node.end,
        node.value === "" ? '"mutated"' : '""',
      )
    },
    TemplateLiteral(path) {
      const node = path.node
      if (node.quasis.every((quasi) => quasi.value.raw === "")) return
      add("string", node, node.start, node.end, "``")
    },
    IfStatement(path) {
      const test = path.node.test
      add("condition", test, test.start, test.end, "true")
      add("condition", test, test.start, test.end, "false")
    },
    ConditionalExpression(path) {
      const test = path.node.test
      add("condition", test, test.start, test.end, "true")
      add("condition", test, test.start, test.end, "false")
    },
    WhileStatement(path) {
      const test = path.node.test
      add("condition", test, test.start, test.end, "false")
    },
    DoWhileStatement(path) {
      const test = path.node.test
      add("condition", test, test.start, test.end, "false")
    },
    ExpressionStatement(path) {
      const node = path.node
      const expression = node.expression
      const kinds = [
        "CallExpression",
        "AssignmentExpression",
        "AwaitExpression",
      ]
      if (!kinds.includes(expression.type)) return
      if (
        expression.type === "AssignmentExpression" &&
        source
          .slice(expression.left.start, expression.left.end)
          .startsWith("module.exports")
      ) {
        return
      }
      add("statement", node, node.start, node.end, ";")
    },
    ReturnStatement(path) {
      const node = path.node
      if (!node.argument) return
      add("return", node, node.argument.start, node.argument.end, "undefined")
    },
    Function(path) {
      const node = path.node
      if (node.kind === "constructor") return
      const body = node.body
      if (body.type !== "BlockStatement" || body.body.length === 0) return
      add("body", node, body.start, body.end, "{}")
    },
    ContinueStatement(path) {
      const node = path.node
      add("statement", node, node.start, node.end, ";")
    },
    BreakStatement(path) {
      const node = path.node
      if (path.findParent((parent) => parent.isSwitchStatement())) return
      add("statement", node, node.start, node.end, ";")
    },
  })

  const seen = new Set()
  return mutants.filter((mutant) => {
    if (seen.has(mutant.id)) return false
    seen.add(mutant.id)
    try {
      parser.parse(apply(source, mutant), { sourceType: "script" })
      return true
    } catch {
      return false
    }
  })
}

function apply(source, mutant) {
  return (
    source.slice(0, mutant.start) +
    mutant.replacement +
    source.slice(mutant.end)
  )
}

module.exports = { generate, apply }
