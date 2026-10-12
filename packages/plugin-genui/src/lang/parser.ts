import { Result } from "effect"
import type { BinaryOperator, Expr, Issue, Program, Statement } from "./ast.js"
import { tokenize, type Mark, type Token } from "./lexer.js"

export interface Parsed {
  readonly statement?: Statement
  readonly issue?: Issue
}

/** Reuses each finished statement's parse across streaming updates, keyed by its line and text. */
export type Cache = Map<string, Parsed>

/**
 * Parses a program. With `partial`, the last statement may still be streaming: anything left open at its end, such as
 * a string, a call or a list, is closed where it stops instead of failing.
 */
export function parse(source: string, options: { readonly partial?: boolean; readonly cache?: Cache } = {}): Program {
  const slices = split(source)
  const parsed = slices.map((slice, index) => {
    if (options.partial === true && index === slices.length - 1) return parseStatement(slice.text, slice.line, true)
    const key = `${slice.line}\n${slice.text}`
    const cached = options.cache?.get(key)
    if (cached) return cached
    const result = parseStatement(slice.text, slice.line, false)
    options.cache?.set(key, result)
    return result
  })

  return {
    statements: parsed.flatMap((item) => (item.statement ? [item.statement] : [])),
    issues: parsed.flatMap((item) => (item.issue ? [item.issue] : [])),
  }
}

/** Each statement's source and first line. Statements end at a line break outside brackets; strings never span lines. */
export function split(source: string) {
  const slices: { readonly text: string; readonly line: number }[] = []
  let depth = 0
  let quote = ""
  let comment = false
  let start = 0
  let line = 1
  let first = 1

  for (let index = 0; index < source.length; index++) {
    const char = source.charAt(index)
    if (char === "\n") {
      // A string open at a line break is a mistake; ending its statement here keeps the next lines intact.
      if (quote) depth = 0
      quote = ""
      comment = false
      if (depth === 0) {
        slices.push({ text: source.slice(start, index), line: first })
        start = index + 1
        first = line + 1
      }
      line++
      continue
    }
    if (comment) continue
    if (quote) {
      if (char === "\\" && source.charAt(index + 1) !== "\n") index++
      else if (char === quote) quote = ""
      continue
    }
    if (char === "#" || (char === "/" && source.charAt(index + 1) === "/")) comment = true
    else if (char === '"' || char === "'") quote = char
    else if (char === "(" || char === "[" || char === "{") depth++
    else if (char === ")" || char === "]" || char === "}") depth = Math.max(0, depth - 1)
  }

  slices.push({ text: source.slice(start), line: first })
  return slices.filter((slice) => slice.text.trim())
}

function parseStatement(text: string, line: number, partial: boolean): Parsed {
  const lexed = tokenize(text)
  const head = lexed.tokens[0]
  const id = head?.kind === "name" || head?.kind === "state" ? head.value : undefined
  const issue = (message: string): Parsed => (partial ? {} : { issue: { statement: id, line, message } })

  if (lexed.tokens.length === 0 && !lexed.error) return {}
  if (lexed.error) return issue(lexed.error)
  if (lexed.open && !partial) return issue("A string is not closed. Strings must end on the line they start on.")
  if (!id) return issue("Expected a statement: name = Expression")
  if (!isMark(lexed.tokens[1], "=")) return issue(`Expected = after ${id}`)
  if (lexed.tokens.length === 2) return issue(`${id} has no value`)

  const expr = Result.try({
    try: () => expression(lexed.tokens.slice(2), partial),
    catch: (error) => (error instanceof SyntaxError ? error.message : String(error)),
  })
  if (Result.isFailure(expr)) return issue(expr.failure)
  return { statement: { id, line, expr: expr.success } }
}

const levels: readonly (readonly BinaryOperator[])[] = [
  ["||"],
  ["&&"],
  ["==", "!="],
  ["<", ">", "<=", ">="],
  ["+", "-"],
  ["*", "/", "%"],
]

const nothing: Expr = { type: "literal", value: null }

/** Recursive descent over one statement's value. Throws a SyntaxError at the first token that does not fit. */
function expression(tokens: readonly Token[], partial: boolean): Expr {
  let index = 0
  const end = () => index >= tokens.length
  // A statement still streaming may stop anywhere; the open structure closes where it stopped.
  const stopped = () => partial && end()
  const eat = (mark: Mark) => {
    if (!isMark(tokens[index], mark)) return false
    index++
    return true
  }
  const fail = (message: string): never => {
    throw new SyntaxError(message)
  }
  const unexpected = () => {
    const token = tokens[index]
    return token ? `Unexpected ${describe(token)}` : "Unexpected end of statement"
  }

  const conditional = (): Expr => {
    const test = binary(0)
    if (!eat("?")) return test
    const then = conditional()
    if (!eat(":"))
      return stopped()
        ? { type: "conditional", test, then, otherwise: nothing }
        : fail("Expected : in a ? : expression")
    return { type: "conditional", test, then, otherwise: conditional() }
  }

  const binary = (level: number): Expr => {
    const operators = levels[level]
    if (!operators) return unary()
    let left = binary(level + 1)
    while (true) {
      const token = tokens[index]
      const operator = token?.kind === "mark" ? operators.find((candidate) => candidate === token.value) : undefined
      if (!operator) return left
      index++
      if (stopped()) return left
      left = { type: "binary", operator, left, right: binary(level + 1) }
    }
  }

  const unary = (): Expr => {
    if (eat("!")) return { type: "unary", operator: "!", operand: unary() }
    if (eat("-")) return { type: "unary", operator: "-", operand: unary() }
    return primary()
  }

  const primary = (): Expr => {
    const token = tokens[index]
    if (!token) return stopped() ? nothing : fail(unexpected())
    index++
    if (token.kind === "string" || token.kind === "number") return { type: "literal", value: token.value }
    if (token.kind === "state") return { type: "state", name: token.value }
    if (token.kind === "name") {
      if (token.value === "true" || token.value === "false") return { type: "literal", value: token.value === "true" }
      if (token.value === "null") return nothing
      if (!eat("(")) return { type: "ref", name: token.value }
      return { type: "call", name: token.value, args: sequence(")") }
    }
    if (token.value === "[") return { type: "list", items: sequence("]") }
    if (token.value === "{") return { type: "object", entries: entries() }
    if (token.value !== "(") return fail(`Unexpected ${describe(token)}`)
    const inner = conditional()
    if (!eat(")") && !stopped()) fail("Expected )")
    return inner
  }

  const sequence = (close: Mark) => {
    const items: Expr[] = []
    while (!eat(close)) {
      if (stopped()) return items
      items.push(conditional())
      if (eat(close) || stopped()) return items
      if (!eat(","))
        fail(`Expected , or ${close}, found ${end() ? "the end of the statement" : describe(tokens[index])}`)
    }
    return items
  }

  const entries = () => {
    const result: (readonly [string, Expr])[] = []
    while (!eat("}")) {
      if (stopped()) return result
      const key = tokens[index]
      if (!key || (key.kind !== "name" && key.kind !== "string"))
        return fail(`Expected an object key, found ${key ? describe(key) : "the end of the statement"}`)
      index++
      if (!eat(":")) return stopped() ? result : fail(`Expected : after ${key.value}`)
      if (stopped()) return result
      result.push([key.value, conditional()])
      if (eat("}") || stopped()) return result
      if (!eat(",")) fail("Expected , or }")
    }
    return result
  }

  const result = conditional()
  if (!end()) fail(unexpected())
  return result
}

function isMark(token: Token | undefined, mark: Mark) {
  return token?.kind === "mark" && token.value === mark
}

function describe(token: Token | undefined) {
  if (!token) return "nothing"
  if (token.kind === "string") return `string ${JSON.stringify(token.value)}`
  return `${token.value}`
}
