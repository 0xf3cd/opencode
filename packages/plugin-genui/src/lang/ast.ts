export type Literal = string | number | boolean | null

export type BinaryOperator = "||" | "&&" | "==" | "!=" | "<" | ">" | "<=" | ">=" | "+" | "-" | "*" | "/" | "%"

export type Expr =
  | { readonly type: "literal"; readonly value: Literal }
  | { readonly type: "list"; readonly items: readonly Expr[] }
  | { readonly type: "object"; readonly entries: readonly (readonly [string, Expr])[] }
  | { readonly type: "ref"; readonly name: string }
  | { readonly type: "state"; readonly name: string }
  | { readonly type: "call"; readonly name: string; readonly args: readonly Expr[] }
  | { readonly type: "unary"; readonly operator: "!" | "-"; readonly operand: Expr }
  | { readonly type: "binary"; readonly operator: BinaryOperator; readonly left: Expr; readonly right: Expr }
  | { readonly type: "conditional"; readonly test: Expr; readonly then: Expr; readonly otherwise: Expr }

/** One `name = expression` line. State declarations keep their `$`, e.g. `$count`. */
export interface Statement {
  readonly id: string
  readonly line: number
  readonly expr: Expr
}

/** A problem the author can fix, located by statement when it belongs to one. */
export interface Issue {
  readonly statement?: string
  readonly line?: number
  readonly message: string
}

export interface Program {
  readonly statements: readonly Statement[]
  readonly issues: readonly Issue[]
}
