export * as GenUILang from "./lang.js"
export type { BinaryOperator, Expr, Issue, Literal, Program, Statement } from "./lang/ast.js"
export { catalog, print, signature, type Catalog, type Component, type Field, type Slot } from "./lang/components.js"
export { Action, check, initial, perform, render, type Data, type Outcome, type State } from "./lang/evaluate.js"
export { parse, type Cache } from "./lang/parser.js"

import { parse, type Cache } from "./lang/parser.js"

/** A parser for one program as it streams in: each finished statement parses once, however often the program grows. */
export function parser() {
  const cache: Cache = new Map()
  return (source: string, partial: boolean) => parse(source, { partial, cache })
}
