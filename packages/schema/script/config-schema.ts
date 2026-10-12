import { isDeepStrictEqual, parseArgs } from "node:util"
import { Schema } from "effect"
import { Config } from "../src/config.js"

// Generates the JSON schemas for `opencode.json`:
// - `--v2`: the strict schema generated from `Config.Info`, served at https://opencode.ai/v2/config.json.
// - `--compat`: the schema served at https://opencode.ai/config.json. Core still loads V1 configs and configs that
//   mix V1 and V2 keys, so this schema accepts both. V1 keys come from `config-v1.json`, a frozen snapshot of the
//   last V1 schema, and keys only V1 accepts are marked deprecated.
const args = parseArgs({
  options: { v2: { type: "string" }, compat: { type: "string" }, check: { type: "boolean" } },
}).values
if (!args.v2 && !args.compat) throw new Error("Pass --v2 and/or --compat output paths")

type Json = { [key: string]: unknown }
interface ObjectSchema {
  description?: string
  properties?: Record<string, Json>
  required?: string[]
  additionalProperties?: boolean | Json
}

// Core merges V1 and V2 members inside these objects; every other value must be entirely V1 or entirely V2.
// See `packages/core/src/config/normalize.ts` and the "Migrate from V1" guide.
const mixedObjects = new Set(["mcp", "compaction", "experimental"])

const generated = Schema.toJsonSchemaDocument(Config.Info, { onExcessProperty: "error" })
const v1: { $defs: Record<string, Json> } = await Bun.file(new URL("./config-v1.json", import.meta.url)).json()

const v2 = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://opencode.ai/v2/config.json",
  ...generated.schema,
  $defs: generated.definitions,
  allowComments: true,
  allowTrailingCommas: true,
}

const compat = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://opencode.ai/config.json",
  ...mergeObjects(
    generated.definitions[definitionName(String(generated.schema.$ref))] as ObjectSchema,
    prefixV1Refs(v1.$defs.Config) as ObjectSchema,
    (key) => mixedObjects.has(key),
  ),
  $defs: {
    ...generated.definitions,
    ...Object.fromEntries(
      Object.entries(v1.$defs)
        .filter(([name]) => name !== "Config")
        .map(([name, schema]) => [v1Definition(name), prefixV1Refs(schema)]),
    ),
  },
  allowComments: true,
  allowTrailingCommas: true,
}

const outputs = [
  ...(args.v2 ? [{ path: args.v2, document: v2 }] : []),
  ...(args.compat ? [{ path: args.compat, document: compat }] : []),
].map((output) => ({ path: output.path, content: `${JSON.stringify(output.document, null, 2)}\n` }))

if (args.check) {
  const stale = await Promise.all(
    outputs.map(async (output) => (await Bun.file(output.path).text()) !== output.content),
  )
  if (stale.some(Boolean)) {
    console.error("Generated config schemas are stale. Run `bun run generate` from services/www.")
    process.exit(1)
  }
  process.exit(0)
}

await Promise.all(outputs.map((output) => Bun.write(output.path, output.content)))

// Merges a V2 object schema with its V1 counterpart. A member declared by only one version is checked against the
// other version's `additionalProperties` schema as well, so V1 records such as `mcp` still accept their entries.
// Members only V1 accepts are marked deprecated; members whose shapes differ accept either shape.
function mergeObjects(current: ObjectSchema, legacy: ObjectSchema, mixed: (key: string) => boolean): ObjectSchema {
  const currentExtra = extraProperties(current)
  const legacyExtra = extraProperties(legacy)
  const keys = new Set([...Object.keys(current.properties ?? {}), ...Object.keys(legacy.properties ?? {})])
  const required = (current.required ?? []).filter((key) => legacy.required?.includes(key))
  return {
    ...(legacy.description ? { description: legacy.description } : {}),
    type: "object",
    properties: Object.fromEntries(
      [...keys].map((key) => {
        const next = current.properties?.[key] ?? currentExtra
        const prev = legacy.properties?.[key] ?? legacyExtra
        if (!next) return [key, { ...prev, deprecated: true }]
        if (!prev) return [key, next]
        // Prefer the V1 copy of an identical shape because it carries descriptions.
        if (isDeepStrictEqual(withoutDescriptions(prev), withoutDescriptions(next))) return [key, prev]
        if (mixed(key)) return [key, mergeObjects(next, prev, () => false)]
        return [key, { anyOf: [next, prev] }]
      }),
    ),
    ...(required.length ? { required } : {}),
    additionalProperties:
      currentExtra && legacyExtra ? { anyOf: [currentExtra, legacyExtra] } : (currentExtra ?? legacyExtra ?? false),
  } as ObjectSchema
}

function extraProperties(schema: ObjectSchema) {
  return typeof schema.additionalProperties === "object" ? schema.additionalProperties : undefined
}

function definitionName(ref: string) {
  return ref.slice("#/$defs/".length)
}

// V1 definitions are namespaced so they cannot collide with V2 definitions.
function v1Definition(name: string) {
  return `V1.${name}`
}

function prefixV1Refs(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prefixV1Refs)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) =>
      key === "$ref" && typeof item === "string" && item.startsWith("#/$defs/")
        ? [key, `#/$defs/${v1Definition(definitionName(item))}`]
        : [key, prefixV1Refs(item)],
    ),
  )
}

function withoutDescriptions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutDescriptions)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "description")
      .map(([key, item]) => [key, withoutDescriptions(item)]),
  )
}
