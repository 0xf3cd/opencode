import { expect } from "bun:test"
import { NodeHttpServer } from "@effect/platform-node"
import { McpServer, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/server"
import { Location } from "@opencode/core/location"
import { LocationServiceMap } from "@opencode/core/location-service-map"
import { Mcp } from "@opencode/core/mcp/index"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { Context, Effect, Layer, Schedule } from "effect"
import { HttpRouter, HttpServer } from "effect/http"
import fs from "node:fs/promises"
import { createServer } from "node:http"
import os from "node:os"
import path from "node:path"
import { it } from "../../core/test/lib/effect"
import { createRoutes } from "../src/routes"

// The DOM lib hides Bun's WebSocket constructor overload that accepts upgrade request headers.
declare const WebSocket: {
  new (url: string | URL, options?: Bun.WebSocketOptions): globalThis.WebSocket
}

const authorization = `Basic ${btoa("opencode:secret")}`

const serve = Effect.fnUntraced(function* () {
  const directory = yield* Effect.acquireRelease(
    Effect.promise(() => fs.mkdtemp(path.join(os.tmpdir(), "opencode-client-mcp-")).then((dir) => fs.realpath(dir))),
    (directory) => Effect.promise(() => fs.rm(directory, { recursive: true, force: true })),
  )
  const context = yield* Layer.build(
    createRoutes({
      password: "secret",
      app: { version: "test-version" },
      database: { path: ":memory:" },
      models: { fetch: false },
      config: { directory, project: false, content: "{}" },
      fs: { filewatcher: false },
    }).pipe(Layer.provideMerge(NodeHttpServer.layerHttpServices)),
  )
  const server = createServer()
  const http = yield* NodeHttpServer.make(() => server, { port: 0, host: "127.0.0.1" })
  yield* Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections()))
  yield* http
    .serve(Context.get(context, HttpRouter.HttpRouter).asHttpEffect())
    .pipe(Effect.provide(NodeHttpServer.layerHttpServices))
  const base = HttpServer.formatAddress(http.address)
  const location = LocationServiceMap.Service.get(
    LocationServiceMap.canonical(Location.Ref.make({ directory: directory as Location.Ref["directory"] })),
  )
  return {
    base,
    directory,
    url: (query: Record<string, string>) => {
      const url = new URL("/api/experimental/client-mcp", base)
      url.protocol = "ws:"
      url.searchParams.set("location[directory]", directory)
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
      return url
    },
    inLocation: <A, E>(effect: Effect.Effect<A, E, Mcp.Service | Tool.Service | McpTool.Service>) =>
      effect.pipe(Effect.provide(location), Effect.provideContext(context)),
  }
})

/** Hosts an MCP server over a WebSocket opened to the endpoint, recording each call's session. */
const connectClient = (url: URL, headers?: Record<string, string>) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const socket = new WebSocket(url, { headers })
      const state = { open: false, closed: false, code: 0 }
      const sessions: unknown[] = []
      const transport: Transport = {
        start: async () => {},
        send: async (message: JSONRPCMessage) => socket.send(JSON.stringify(message)),
        close: async () => socket.close(),
      }
      socket.addEventListener("open", () => {
        state.open = true
      })
      socket.addEventListener("message", (event) => transport.onmessage?.(JSON.parse(String(event.data))))
      socket.addEventListener("close", (event) => {
        state.closed = true
        state.code = event.code
        transport.onclose?.()
      })
      const server = new McpServer({ name: "test-client", version: "1.0.0" })
      server.registerTool("open_terminal", { description: "Open a terminal" }, (ctx) => {
        sessions.push(ctx.mcpReq._meta?.["ai.opencode/sessionID"])
        return { content: [{ type: "text", text: "opened" }] }
      })
      await server.connect(transport)
      return { socket, state, sessions }
    }),
    (client) => Effect.sync(() => client.socket.close()),
  )

const until = (check: () => boolean | Promise<boolean>) =>
  Effect.promise(async () => check()).pipe(
    Effect.flatMap((done) => (done ? Effect.void : Effect.fail("pending"))),
    Effect.retry({ times: 500, schedule: Schedule.spaced("10 millis") }),
    Effect.orDie,
  )

const registryIDs = Effect.gen(function* () {
  const registration = yield* McpTool.Service
  yield* registration.flush
  const registry = yield* Tool.Service
  return (yield* registry.list()).map((tool) => tool.id)
})

it.live(
  "attaches a client MCP server for the lifetime of its socket",
  () =>
    Effect.gen(function* () {
      const server = yield* serve()
      const client = yield* connectClient(server.url({ name: "tui" }), { authorization })
      const tools = () => Effect.runPromise(server.inLocation(Mcp.Service.use((mcp) => mcp.tools())))

      yield* until(async () => (await tools()).length > 0)
      expect((yield* Effect.promise(tools)).map((tool) => [tool.server, tool.name])).toEqual([["tui", "open_terminal"]])
      yield* until(() =>
        Effect.runPromise(server.inLocation(registryIDs)).then((ids) => ids.includes("tui_open_terminal")),
      )

      const result = yield* server.inLocation(
        Mcp.Service.use((mcp) =>
          mcp.callTool({ server: "tui", name: "open_terminal", sessionID: Session.ID.make("ses_client_mcp") }),
        ),
      )
      expect(result.content).toEqual([{ type: "text", text: "opened" }])
      expect(client.sessions).toEqual(["ses_client_mcp"])

      // The last client to attach a name wins; the replaced socket closes normally.
      const replacement = yield* connectClient(server.url({ name: "tui" }), { authorization })
      yield* until(() => client.state.closed)
      expect(client.state.code).toBe(1000)
      yield* until(async () => (await tools()).length > 0)

      replacement.socket.close()
      yield* until(async () => (await tools()).length === 0)
      yield* until(() =>
        Effect.runPromise(server.inLocation(registryIDs)).then((ids) => !ids.includes("tui_open_terminal")),
      )
    }),
  20_000,
)

it.live(
  "accepts a single-use ticket instead of credentials",
  () =>
    Effect.gen(function* () {
      const server = yield* serve()
      const token = (name: string) =>
        Effect.promise(async () => {
          const url = new URL("/api/experimental/client-mcp/token", server.base)
          url.searchParams.set("location[directory]", server.directory)
          url.searchParams.set("name", name)
          const response = await fetch(url, {
            method: "POST",
            headers: { authorization, "x-opencode-ticket": "1" },
          })
          expect(response.status).toBe(200)
          return ((await response.json()) as { data: { ticket: string } }).data.ticket
        })

      const unauthenticated = yield* connectClient(server.url({ name: "web" }))
      yield* until(() => unauthenticated.state.closed)
      expect(unauthenticated.state.open).toBeFalse()

      const ticket = yield* token("web")
      const mismatched = yield* connectClient(server.url({ name: "other", ticket }))
      yield* until(() => mismatched.state.closed)
      expect(mismatched.state.open).toBeFalse()

      const fresh = yield* token("web")
      const client = yield* connectClient(server.url({ name: "web", ticket: fresh }))
      yield* until(() =>
        Effect.runPromise(server.inLocation(Mcp.Service.use((mcp) => mcp.tools()))).then((tools) =>
          tools.some((tool) => tool.server === "web"),
        ),
      )
      expect(client.state.open).toBeTrue()

      const reused = yield* connectClient(server.url({ name: "web", ticket: fresh }))
      yield* until(() => reused.state.closed)
      expect(reused.state.open).toBeFalse()

      // The server's end of an accepted socket lives in the serving scope until the client disconnects.
      client.socket.close()
      yield* until(() => client.state.closed)
    }),
  20_000,
)

it.live(
  "rejects an invalid client name",
  () =>
    Effect.gen(function* () {
      const server = yield* serve()
      const url = server.url({ name: "bad name!" })
      url.protocol = "http:"
      const response = yield* Effect.promise(() => fetch(url, { headers: { authorization } }))
      expect(response.status).toBe(400)

      const client = yield* connectClient(server.url({ name: "bad.name" }), { authorization })
      yield* until(() => client.state.closed)
      expect(client.state.open).toBeFalse()
    }),
  20_000,
)
