export * as ConfigMcpPlugin from "./mcp.js"

import { define } from "@opencode/plugin/effect/plugin"
import { Document, type Entry } from "@opencode/schema/config"
import type { ServerConfig } from "@opencode/schema/mcp"
import { Effect, Stream } from "effect"
import { Config } from "../../config.js"
import type { ConfigVariable } from "../variable.js"
import { Mcp } from "../../mcp/index.js"

export const Plugin = define({
  id: "opencode.config.mcp",
  effect: Effect.fn(function* (ctx) {
    yield* register(ctx.event.subscribe())
  }),
})

export const register = Effect.fn("ConfigMCPPlugin.register")(function* (
  events: Stream.Stream<{ readonly type: string }, unknown>,
) {
  const config = yield* Config.Service
  const mcp = yield* Mcp.Service
  const none: ReadonlyMap<Document, readonly ConfigVariable.Unresolved[]> = new Map()
  const load = Effect.all({ entries: config.entries(), unresolved: config.unresolved?.() ?? Effect.succeed(none) })
  const loaded = { entries: [] as Entry[], unresolved: none }

  yield* events.pipe(
    Stream.filter((event) => event.type === "config.updated"),
    Stream.runForEach(() =>
      load.pipe(
        Effect.tap((next) => Effect.sync(() => Object.assign(loaded, next))),
        Effect.andThen(mcp.reload()),
        Effect.catchCause((cause) => Effect.logError("failed to reload MCP config", { cause })),
      ),
    ),
    Effect.ignore,
    Effect.forkScoped({ startImmediately: true }),
  )

  // Subscribe before the initial load so updates racing it trigger a rebuild.
  Object.assign(loaded, yield* load)
  yield* mcp.transform((editor) => {
    const documents = loaded.entries.filter((entry): entry is Document => entry.type === "document")
    // Global timeout defaults merge in config order; each server can override them.
    const timeout = Object.assign(
      {},
      ...documents.flatMap((entry) => (entry.info.mcp?.timeout ? [entry.info.mcp.timeout] : [])),
    )
    const servers = new Map<string, { server: ServerConfig; document: Document }>()
    for (const document of documents) {
      for (const [name, server] of Object.entries(document.info.mcp?.servers ?? {})) {
        servers.set(name, { server, document })
      }
    }
    for (const [name, { server, document }] of servers) {
      if (editor.get(name)) continue
      editor.set(name, { ...server, timeout: { ...timeout, ...server.timeout } })
      const reference = loaded.unresolved.get(document)?.find((item) => serverName(item.path) === name)
      if (reference) editor.fail(name, describe(reference))
    }
  })
})

// Native servers live under mcp.servers.<name>; legacy documents list them directly under mcp.<name>.
function serverName(path: ConfigVariable.Unresolved["path"]) {
  if (path[0] !== "mcp") return
  if (path[1] === "servers") return path[2]
  if (path[1] !== "timeout") return path[1]
}

function describe(reference: ConfigVariable.Unresolved) {
  const problem = reference.reason === "NotFound" ? "does not exist" : `could not be read (${reference.reason})`
  return `bad file reference "${reference.reference}": ${reference.file} ${problem}`
}
