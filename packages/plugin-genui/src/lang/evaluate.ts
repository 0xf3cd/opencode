import { Option, Result, Schema } from "effect"
import type { BinaryOperator, Expr, Issue, Literal, Program, Statement } from "./ast.js"
import { signature, type Catalog, type Component, type Field } from "./components.js"

/** JSON-like values: what state holds and what a button can set. */
export type Data = Literal | readonly Data[] | { readonly [key: string]: Data }

export type State = ReadonlyMap<string, Data>

export type ActionName = "set" | "reset" | "reply" | "open"

/** What pressing a button does. Its arguments evaluate when the user presses it, against the state at that moment. */
export class Action {
  constructor(
    readonly name: ActionName,
    readonly args: readonly Expr[],
  ) {}
}

/** A rendered component, already decoded. */
class Element {
  constructor(
    readonly typeName: string,
    readonly node: unknown,
  ) {}
}

type Value = Data | readonly Value[] | { readonly [key: string]: Value } | Action | Element

/** The effect of one action, for the renderer to apply. */
export type Outcome =
  | { readonly type: "set"; readonly name: string; readonly value: Data }
  | { readonly type: "reset"; readonly names: readonly string[] }
  | { readonly type: "reply"; readonly message: string }
  | { readonly type: "open"; readonly url: string }

const actions: Readonly<Record<ActionName, { readonly arity: (count: number) => boolean; readonly usage: string }>> = {
  set: { arity: (count) => count === 2, usage: "set($name, value)" },
  reset: { arity: () => true, usage: "reset($name, ...), or reset() for every $name" },
  reply: { arity: (count) => count === 1, usage: "reply(message)" },
  open: { arity: (count) => count === 1, usage: "open(url)" },
}

const isAction = (name: string): name is ActionName => Object.hasOwn(actions, name)

export interface RenderOptions<S extends Schema.Decoder<unknown>> {
  readonly catalog: Catalog
  /** The schema the root must decode to. Its component is the only one allowed at the root. */
  readonly root: S
  readonly state: State
  /**
   * The last node each statement rendered. While a program streams, a statement that does not render yet, such as a
   * chart whose last data point is half written, keeps showing its previous node instead of disappearing.
   */
  readonly memory?: Map<string, unknown>
}

/** Renders a program against a state. Nodes that fail are left out and reported; everything else still renders. */
export function render<S extends Schema.Decoder<unknown>>(program: Program, options: RenderOptions<S>) {
  const run = evaluator(program, options.catalog, options.state, options.memory)
  const root = rootOf(program)
  if (!root) return { root: null, issues: [{ message: "Nothing to render. Start with root = Surface([...])." }] }
  const value = run.statement(root, undefined)
  const decoded = value instanceof Element ? Schema.decodeUnknownOption(options.root)(value.node) : Option.none()
  if (Option.isNone(decoded))
    run.report(
      program.statements.find((statement) => statement.id === root),
      `${root} must be a ${nameOf(options.root)}(...)`,
    )
  return { root: Option.getOrNull(decoded), issues: run.issues }
}

/** The starting value of every `$name`. Each may use the ones declared before it. */
export function initial(program: Program, catalog: Catalog) {
  const issues: Issue[] = []
  const state = new Map<string, Data>()
  program.statements
    .filter((statement) => statement.id.startsWith("$"))
    .forEach((statement) => {
      const run = evaluator(program, catalog, state)
      const value = run.evaluate(statement.expr, statement)
      issues.push(...run.issues)
      if (isData(value)) return state.set(statement.id, value)
      issues.push(at(statement, `${statement.id} must start as text, a number, true, false, null, a list or an object`))
      state.set(statement.id, null)
    })
  return { state, issues }
}

/** Evaluates an action against the current state. Returns nothing for an action that cannot run. */
export function perform(action: Action, program: Program, catalog: Catalog, state: State): Outcome | undefined {
  const run = evaluator(program, catalog, state)
  const target = action.args[0]
  if (action.name === "set") {
    const value = action.args[1] ? run.evaluate(action.args[1], undefined) : null
    if (target?.type !== "state" || !state.has(target.name) || !isData(value)) return undefined
    return { type: "set", name: target.name, value }
  }
  if (action.name === "reset")
    return {
      type: "reset",
      names:
        action.args.length === 0
          ? [...state.keys()]
          : action.args.flatMap((arg) => (arg.type === "state" ? [arg.name] : [])),
    }
  const value = target ? run.evaluate(target, undefined) : null
  if (action.name === "reply") return { type: "reply", message: text(value) }
  return typeof value === "string" ? { type: "open", url: value } : undefined
}

/**
 * Everything wrong with a finished program, for the author: syntax, unknown names, wrong arguments, values of the
 * wrong type at the initial state, and statements nothing uses.
 */
export function check<S extends Schema.Decoder<unknown>>(program: Program, catalog: Catalog, root: S) {
  const start = initial(program, catalog)
  const rendered = render(program, { catalog, root, state: start.state })
  const issues = [
    ...program.issues,
    ...duplicates(program),
    ...start.issues,
    ...rendered.issues,
    ...lint(program, catalog),
  ]
  const seen = new Set<string>()
  return {
    root: rendered.root,
    issues: issues.filter((issue) => {
      const key = `${issue.statement ?? ""}\n${issue.message}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }),
  }
}

function evaluator(program: Program, catalog: Catalog, state: State, memory?: Map<string, unknown>) {
  const statements = new Map(program.statements.map((statement) => [statement.id, statement]))
  const values = new Map<string, Value>()
  const stack: string[] = []
  const issues: Issue[] = []
  const report = (statement: Statement | undefined, message: string) => issues.push(at(statement, message))

  const statement = (id: string, from: Statement | undefined): Value => {
    const known = values.get(id)
    if (known !== undefined) return known
    const target = statements.get(id)
    const remembered = memory?.get(id)
    const kept = remembered instanceof Element ? remembered : undefined
    if (!target) {
      if (kept) return kept
      report(from, `${id} is used but never defined`)
      return null
    }
    if (stack.includes(id)) {
      report(from, `${[...stack.slice(stack.indexOf(id)), id].join(" -> ")} refer to each other in a loop`)
      return null
    }
    stack.push(id)
    const value = evaluate(target.expr, target, id)
    stack.pop()
    const result = value === null && kept ? kept : value
    if (result instanceof Element && target.expr.type === "call") memory?.set(id, result)
    values.set(id, result)
    return result
  }

  const evaluate = (expr: Expr, at: Statement | undefined, id?: string): Value => {
    switch (expr.type) {
      case "literal":
        return expr.value
      case "list":
        return expr.items.map((item) => evaluate(item, at))
      case "object":
        return Object.fromEntries(expr.entries.map(([key, value]) => [key, evaluate(value, at)]))
      case "ref":
        return statement(expr.name, at)
      case "state": {
        const value = state.get(expr.name)
        if (value !== undefined) return value
        if (!state.has(expr.name)) report(at, undeclared(expr.name, state))
        return null
      }
      case "unary": {
        const operand = evaluate(expr.operand, at)
        if (expr.operator === "!") return !truthy(operand)
        if (typeof operand === "number") return -operand
        report(at, `- needs a number, got ${kind(operand)}`)
        return null
      }
      case "binary": {
        const left = evaluate(expr.left, at)
        if (expr.operator === "&&") return truthy(left) ? evaluate(expr.right, at) : left
        if (expr.operator === "||") return truthy(left) ? left : evaluate(expr.right, at)
        return binary(expr.operator, left, evaluate(expr.right, at), at)
      }
      case "conditional":
        return truthy(evaluate(expr.test, at)) ? evaluate(expr.then, at) : evaluate(expr.otherwise, at)
      case "call":
        return call(expr.name, expr.args, at, id)
    }
  }

  const binary = (operator: BinaryOperator, left: Value, right: Value, at: Statement | undefined): Value => {
    if (operator === "==") return equal(left, right)
    if (operator === "!=") return !equal(left, right)
    if (operator === "+" && (typeof left === "string" || typeof right === "string"))
      return `${text(left)}${text(right)}`
    const ordering = operator === "<" || operator === ">" || operator === "<=" || operator === ">="
    if (ordering && typeof left === "string" && typeof right === "string") return compare(operator, left, right)
    if (typeof left !== "number" || typeof right !== "number") {
      report(
        at,
        `${operator} needs two numbers${operator === "+" ? " or some text" : ""}, got ${kind(left)} and ${kind(right)}`,
      )
      return null
    }
    if ((operator === "/" || operator === "%") && right === 0) {
      report(at, `${operator} by zero`)
      return null
    }
    if (operator === "+") return left + right
    if (operator === "-") return left - right
    if (operator === "*") return left * right
    if (operator === "/") return left / right
    if (operator === "%") return left % right
    return compare(operator, left, right)
  }

  const call = (name: string, args: readonly Expr[], at: Statement | undefined, id: string | undefined): Value => {
    if (isAction(name)) return new Action(name, args)
    const component = catalog.components.get(name)
    if (!component) {
      report(at, unknownComponent(name, catalog))
      return null
    }
    return element(
      component,
      args.map((arg) => evaluate(arg, at)),
      at,
      id,
    )
  }

  const element = (component: Component, args: readonly Value[], at: Statement | undefined, id: string | undefined) => {
    if (args.length > component.fields.length)
      report(at, `${signature(component)} takes ${component.fields.length} arguments, got ${args.length}`)
    const props: Record<string, unknown> = {}
    for (const [index, field] of component.fields.entries()) {
      const arg = args[index]
      const value =
        arg === undefined || arg === null
          ? arg
          : field.slot
            ? slot(component, field, arg, at)
            : plain(component, field, arg, at)
      if ((value === undefined || value === null) && !field.optional) {
        if (value !== null || arg === null) report(at, `${component.name} needs ${field.name}: ${signature(component)}`)
        return null
      }
      if (value !== undefined) props[field.name] = value
    }
    const decoded = component.decode({
      typeName: component.name,
      props,
      ...(id === undefined ? {} : { statementId: id }),
    })
    if (Result.isSuccess(decoded)) return new Element(component.name, decoded.success)
    decoded.failure.forEach((message) => report(at, message))
    return null
  }

  // A field that holds components takes rendered nodes. Others take data and actions, never a rendered node.
  const slot = (component: Component, field: Field, arg: Value, at: Statement | undefined) => {
    const allowed = field.slot?.names ?? []
    const type = field.slot?.list ? field.type.replace(/^\((.*)\)\[\]$|\[\]$/u, "$1") : field.type
    const accept = (item: Value) => {
      if (item === null) return []
      if (item instanceof Element && allowed.includes(item.typeName)) return [item.node]
      const homes =
        item instanceof Element
          ? [...catalog.components.values()].filter((other) =>
              other.fields.some((candidate) => candidate.slot?.names.includes(item.typeName)),
            )
          : []
      const hint = homes.length > 0 ? `; ${kind(item)} goes in ${homes.map((home) => home.name).join(" or ")}` : ""
      report(at, `${component.name}.${field.name} takes ${type}, not ${kind(item)}${hint}`)
      return []
    }
    if (!field.slot?.list) return accept(arg)[0] ?? null
    if (!Array.isArray(arg)) {
      report(at, `${component.name}.${field.name} takes a list of ${type}`)
      return null
    }
    return arg.flatMap(accept)
  }

  const plain = (component: Component, field: Field, arg: Value, at: Statement | undefined) => {
    if (!contains(arg, (item) => item instanceof Element)) return arg
    report(at, `${component.name}.${field.name} takes ${field.type}, not a component`)
    return null
  }

  return { statement, evaluate, issues, report }
}

/** Unknown names, wrong arity and orphans, across every branch, including the ones the initial state skips. */
function lint(program: Program, catalog: Catalog) {
  const statements = new Map(program.statements.map((statement) => [statement.id, statement]))
  const declared = new Set(
    program.statements.filter((statement) => statement.id.startsWith("$")).map((statement) => statement.id),
  )
  const issues: Issue[] = []

  const walk = (expr: Expr, statement: Statement, visit: (name: string) => void): void => {
    if (expr.type === "ref") {
      if (!statements.has(expr.name)) issues.push(at(statement, `${expr.name} is used but never defined`))
      return visit(expr.name)
    }
    if (expr.type === "state") {
      if (!declared.has(expr.name))
        issues.push(at(statement, undeclared(expr.name, new Map([...declared].map((name) => [name, null])))))
      return
    }
    if (expr.type === "call") {
      const component = catalog.components.get(expr.name)
      if (isAction(expr.name)) {
        if (!actions[expr.name].arity(expr.args.length)) issues.push(at(statement, `Use ${actions[expr.name].usage}`))
        if (
          (expr.name === "set" && expr.args[0]?.type !== "state") ||
          (expr.name === "reset" && expr.args.some((arg) => arg.type !== "state"))
        )
          issues.push(at(statement, `${expr.name} takes a $name: ${actions[expr.name].usage}`))
      } else if (!component) issues.push(at(statement, unknownComponent(expr.name, catalog)))
      return expr.args.forEach((arg) => walk(arg, statement, visit))
    }
    if (expr.type === "list") return expr.items.forEach((item) => walk(item, statement, visit))
    if (expr.type === "object") return expr.entries.forEach(([, value]) => walk(value, statement, visit))
    if (expr.type === "unary") return walk(expr.operand, statement, visit)
    if (expr.type === "binary") return [expr.left, expr.right].forEach((side) => walk(side, statement, visit))
    if (expr.type === "conditional")
      return [expr.test, expr.then, expr.otherwise].forEach((part) => walk(part, statement, visit))
  }

  const reached = new Set<string>()
  const reach = (id: string) => {
    const statement = statements.get(id)
    if (!statement || reached.has(id)) return
    reached.add(id)
    walk(statement.expr, statement, reach)
  }
  const root = rootOf(program)
  if (root) reach(root)
  program.statements.forEach((statement) => {
    if (statement.id.startsWith("$")) return walk(statement.expr, statement, () => undefined)
    if (!reached.has(statement.id)) {
      walk(statement.expr, statement, () => undefined)
      issues.push(at(statement, `${statement.id} is defined but nothing under root uses it, so it does not render`))
    }
  })
  return issues
}

function duplicates(program: Program) {
  const seen = new Set<string>()
  return program.statements.flatMap((statement) => {
    if (!seen.has(statement.id)) {
      seen.add(statement.id)
      return []
    }
    return [at(statement, `${statement.id} is defined more than once; the last one wins`)]
  })
}

function rootOf(program: Program) {
  if (program.statements.some((statement) => statement.id === "root")) return "root"
  return program.statements.find((statement) => !statement.id.startsWith("$"))?.id
}

function at(statement: Statement | undefined, message: string): Issue {
  return statement ? { statement: statement.id, line: statement.line, message } : { message }
}

function unknownComponent(name: string, catalog: Catalog) {
  const names = [...catalog.components.keys()]
  const close = names.find((candidate) => distance(candidate.toLowerCase(), name.toLowerCase()) <= 2)
  if (close) return `${name} is not a component. Did you mean ${close}?`
  if (/^[a-z]/u.test(name)) return `${name} is not a component or an action. Actions are set, reset, reply and open.`
  return `${name} is not a component. Components: ${names.join(", ")}`
}

function undeclared(name: string, state: State) {
  const names = [...state.keys()]
  return `${name} is not declared. Declare it with ${name} = <initial value>${names.length ? ` (declared: ${names.join(", ")})` : ""}`
}

function nameOf(schema: Schema.Decoder<unknown>) {
  return typeof schema.ast.annotations?.identifier === "string" ? schema.ast.annotations.identifier : "component"
}

function truthy(value: Value) {
  return value !== null && value !== false && value !== 0 && value !== ""
}

function equal(left: Value, right: Value): boolean {
  if (left === right) return true
  return isData(left) && isData(right) && JSON.stringify(left) === JSON.stringify(right)
}

function compare(operator: BinaryOperator, left: number | string, right: number | string) {
  if (operator === "<") return left < right
  if (operator === ">") return left > right
  if (operator === "<=") return left <= right
  return left >= right
}

/** How a value reads when joined into text. Numbers drop floating-point noise. */
function text(value: Value): string {
  if (typeof value === "string") return value
  if (typeof value === "number") return String(Math.round(value * 1e6) / 1e6)
  if (typeof value === "boolean") return String(value)
  if (Array.isArray(value)) return value.map(text).join(", ")
  return ""
}

function kind(value: Value): string {
  if (value instanceof Element) return value.typeName
  if (value instanceof Action) return `${value.name}(...)`
  if (value === null) return "null"
  if (Array.isArray(value)) return "a list"
  if (typeof value === "object") return "an object"
  return typeof value === "string" ? `text ${JSON.stringify(value)}` : `${typeof value} ${String(value)}`
}

function isData(value: Value): value is Data {
  return !contains(value, (item) => item instanceof Element || item instanceof Action)
}

function contains(value: Value, test: (value: Value) => boolean): boolean {
  if (test(value)) return true
  if (Array.isArray(value)) return value.some((item) => contains(item, test))
  if (value !== null && typeof value === "object" && !(value instanceof Element) && !(value instanceof Action))
    return Object.values(value).some((item) => contains(item, test))
  return false
}

function distance(left: string, right: string) {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (const [i, a] of [...left].entries()) {
    let previous = row[0] ?? 0
    row[0] = i + 1
    for (const [j, b] of [...right].entries()) {
      const current = row[j + 1] ?? 0
      row[j + 1] = Math.min(current + 1, (row[j] ?? 0) + 1, previous + (a === b ? 0 : 1))
      previous = current
    }
  }
  return row[right.length] ?? 0
}
