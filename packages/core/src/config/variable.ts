export * as ConfigVariable from "./variable.js"

import os from "os"
import path from "path"
import { isDeepStrictEqual } from "node:util"
import { Effect } from "effect"
import {
  applyEdits,
  findNodeAtOffset,
  getNodePath,
  modify,
  parseTree,
  type JSONPath,
  type ParseError,
} from "jsonc-parser"
import { FSUtil } from "@opencode/util/fs-util"

type ParseSource =
  | {
      type: "path"
      path: string
    }
  | {
      type: "virtual"
      source: string
      dir: string
    }

type SubstituteInput = ParseSource & {
  text: string
  env?: Record<string, string>
}

/** A {file:} reference that could not be read; the JSON value holding it was removed. */
export interface Unresolved {
  /** JSON path of the removed value in the source document. */
  readonly path: JSONPath
  readonly reference: string
  readonly file: string
  readonly reason: string
}

export interface Result {
  readonly text: string
  readonly unresolved: readonly Unresolved[]
}

/** Apply {env:VAR} and {file:path} substitutions to config text. */
export const substitute = Effect.fn("ConfigVariable.substitute")(function* (input: SubstituteInput) {
  const text = input.text.replace(
    /\{env:([^}]+)\}/g,
    (_, varName: string) => (input.env?.[varName] ?? process.env[varName]) || "",
  )
  if (!text.includes("{file:")) return { text, unresolved: [] } satisfies Result
  return yield* substituteFiles(input, text)
})

const substituteFiles = Effect.fnUntraced(function* (input: SubstituteInput, text: string) {
  const fs = yield* FSUtil.Service
  const configDir = input.type === "path" ? path.dirname(input.path) : input.dir
  const configSource = input.type === "path" ? input.path : input.source
  const errors: ParseError[] = []
  const tree = parseTree(text, errors, { allowTrailingComma: true })
  const unresolved: Unresolved[] = []
  let out = ""
  let cursor = 0

  for (const match of text.matchAll(/\{file:[^}]+\}/g)) {
    const token = match[0]
    const index = match.index
    out += text.slice(cursor, index)

    const lineStart = text.lastIndexOf("\n", index - 1) + 1
    const prefix = text.slice(lineStart, index).trimStart()
    if (prefix.startsWith("//")) {
      out += token
      cursor = index + token.length
      continue
    }

    const filePath = token.slice("{file:".length, -1)
    const expandedPath = filePath.startsWith("~/") ? path.join(os.homedir(), filePath.slice(2)) : filePath
    const resolvedPath = path.isAbsolute(expandedPath) ? expandedPath : path.resolve(configDir, expandedPath)
    // An unreadable file removes only the value that references it, so one stale reference
    // cannot take down the rest of the Location's config or leave a half-filled value behind.
    const fileContent = yield* fs.readFileString(resolvedPath).pipe(
      Effect.catch((error) =>
        Effect.gen(function* () {
          const valuePath = errors.length === 0 && tree ? stringValuePath(findNodeAtOffset(tree, index)) : undefined
          yield* Effect.logWarning("configuration file reference unavailable", {
            source: configSource,
            path: valuePath ? `$.${valuePath.join(".")}` : "$",
            reference: token,
            file: resolvedPath,
            reason: error.reason._tag,
            action: valuePath ? "removed value" : "substituted empty value",
          })
          if (valuePath && !unresolved.some((item) => isDeepStrictEqual(item.path, valuePath)))
            unresolved.push({ path: valuePath, reference: token, file: resolvedPath, reason: error.reason._tag })
          return ""
        }),
      ),
    )

    out += JSON.stringify(fileContent.trim()).slice(1, -1)
    cursor = index + token.length
  }

  // Remove in reverse document order so earlier array indexes stay valid.
  return {
    text: unresolved
      .toReversed()
      .reduce((text, item) => applyEdits(text, modify(text, item.path, undefined, {})), out + text.slice(cursor)),
    unresolved,
  } satisfies Result
})

function stringValuePath(node: ReturnType<typeof findNodeAtOffset>) {
  if (node?.type !== "string" || !node.parent) return
  if (node.parent.type === "property" && node.parent.children?.[0] === node) return
  return getNodePath(node)
}
