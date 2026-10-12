import { Result, Schema, SchemaAST, SchemaIssue } from "effect"

/** The components a field holds, when it holds components rather than data. */
export interface Slot {
  readonly names: readonly string[]
  readonly list: boolean
}

export interface Field {
  readonly name: string
  readonly optional: boolean
  /** The field's type as the guide and error messages print it, e.g. `string | number` or `Metric[]`. */
  readonly type: string
  readonly slot?: Slot
}

export interface Component {
  readonly name: string
  readonly description: string
  /** Positional order: the nth argument fills the nth field. */
  readonly fields: readonly Field[]
  /** Decodes a `{ typeName, props, statementId? }` node, or lists what is wrong with it. */
  readonly decode: (node: object) => Result.Result<unknown, readonly string[]>
}

export interface Catalog {
  readonly components: ReadonlyMap<string, Component>
}

const format = SchemaIssue.makeFormatterStandardSchemaV1()

/**
 * A catalog from component schemas: structs of `{ typeName, props, statementId? }` whose `typeName` is a literal and
 * whose annotations carry a description. Positional order and slots come from the `props` struct.
 */
export function catalog(elements: readonly Schema.Decoder<unknown>[]): Catalog {
  const names = new Set(elements.map((element) => nameOf(element.ast)))

  return {
    components: new Map(
      elements.map((element) => {
        const name = nameOf(element.ast)
        const decode = Schema.decodeUnknownResult(element)
        const component: Component = {
          name,
          description:
            typeof element.ast.annotations?.description === "string" ? element.ast.annotations.description : "",
          fields: propsOf(element.ast).map((property) => ({
            name: String(property.name),
            optional: property.type.context?.isOptional === true,
            type: print(property.type, true),
            ...slotOf(property.type, names),
          })),
          decode: (node) =>
            Result.mapError(decode(node), (error) =>
              format(error.issue).issues.map((issue) => {
                const keys = (issue.path ?? []).map((segment) => (typeof segment === "object" ? segment.key : segment))
                const path = keys
                  .slice(1)
                  .map((key) => (typeof key === "number" ? `[${key}]` : `.${String(key)}`))
                  .join("")
                const actual = keys.reduce<unknown>(
                  (value, key) =>
                    value !== null && typeof value === "object"
                      ? Object.getOwnPropertyDescriptor(value, key)?.value
                      : undefined,
                  node,
                )
                const got =
                  actual === undefined ? "" : `, got ${JSON.stringify(actual)?.slice(0, 60) ?? String(actual)}`
                return `${name}${path}: ${issue.message}${got}`
              }),
            ),
        }
        return [name, component] as const
      }),
    ),
  }
}

/** `Name(field: type, optional?: type)`, the form the guide teaches. */
export function signature(component: Component) {
  return `${component.name}(${component.fields.map((field) => `${field.name}${field.optional ? "?" : ""}: ${field.type}`).join(", ")})`
}

/** Prints a schema as a short type. Named schemas print their identifier; `top` drops the null of an optional field. */
export function print(ast: SchemaAST.AST, top = false): string {
  const identifier = ast.annotations?.identifier
  if (typeof identifier === "string") return identifier
  if (ast._tag === "Union")
    return [
      ...new Set(
        members(ast)
          .filter((member) => member._tag !== "Undefined" && !(top && member._tag === "Null"))
          .map((member) => print(member)),
      ),
    ].join(" | ")
  if (ast._tag === "Arrays") {
    const item = ast.rest[0]
    if (!item) return "unknown[]"
    return members(item).length > 1 ? `(${print(item)})[]` : `${print(item)}[]`
  }
  if (ast._tag === "Objects")
    return `{${ast.propertySignatures
      .map(
        (property) =>
          `${String(property.name)}${property.type.context?.isOptional ? "?" : ""}: ${print(property.type, true)}`,
      )
      .join(", ")}}`
  if (ast._tag === "Literal") return JSON.stringify(ast.literal)
  if (ast._tag === "String" || ast._tag === "Number" || ast._tag === "Boolean") return ast._tag.toLowerCase()
  if (ast._tag === "Null") return "null"
  return "unknown"
}

/** Union members, flattened through unions that have no name of their own. */
export function members(ast: SchemaAST.AST): SchemaAST.AST[] {
  if (ast._tag !== "Union" || typeof ast.annotations?.identifier === "string") return [ast]
  return ast.types.flatMap(members)
}

function present(ast: SchemaAST.AST) {
  return members(ast).filter((member) => member._tag !== "Null" && member._tag !== "Undefined")
}

function slotOf(ast: SchemaAST.AST, names: ReadonlySet<string>): { readonly slot?: Slot } {
  const types = present(ast)
  const list = types.length === 1 && types[0]?._tag === "Arrays" ? types[0].rest[0] : undefined
  const held = (list ? present(list) : types).flatMap(expand)
  const found = held.flatMap((member) => (member._tag === "Objects" ? [nameOf(member, false)] : []))
  if (held.length === 0 || found.length !== held.length || !found.every((name) => name && names.has(name))) return {}
  return { slot: { names: found.filter((name) => name !== undefined), list: list !== undefined } }
}

/** Named unions such as `Block` hold their members. */
function expand(ast: SchemaAST.AST): SchemaAST.AST[] {
  return ast._tag === "Union" ? ast.types.flatMap(expand) : [ast]
}

function propsOf(ast: SchemaAST.AST) {
  const props =
    ast._tag === "Objects" ? ast.propertySignatures.find((property) => property.name === "props") : undefined
  if (props?.type._tag !== "Objects") throw new Error("A component schema needs a props struct")
  return props.type.propertySignatures
}

function nameOf(ast: SchemaAST.AST, strict?: true): string
function nameOf(ast: SchemaAST.AST, strict: false): string | undefined
function nameOf(ast: SchemaAST.AST, strict = true) {
  const type =
    ast._tag === "Objects" ? ast.propertySignatures.find((property) => property.name === "typeName")?.type : undefined
  if (type?._tag === "Literal" && typeof type.literal === "string") return type.literal
  if (strict) throw new Error("A component schema needs a literal typeName")
  return undefined
}
