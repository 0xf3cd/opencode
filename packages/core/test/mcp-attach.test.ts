import { expect } from "bun:test"
import { InMemoryTransport } from "@modelcontextprotocol/client"
import { McpServer } from "@modelcontextprotocol/server"
import { ConfigMCP } from "@opencode/schema/config/mcp"
import { McpEvent } from "@opencode/schema/mcp-event"
import { Bus } from "@opencode/core/bus"
import { Credential } from "@opencode/core/credential"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Environment } from "@opencode/core/environment/index"
import { Image } from "@opencode/core/image"
import { Integration } from "@opencode/core/integration"
import { Location } from "@opencode/core/location"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Session } from "@opencode/core/session"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Exit, Layer, Schedule, Scope, Stream } from "effect"
import { hostEnvironmentLayer } from "./fixture/environment"
import { tempLocationLayer } from "./fixture/location"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { executeTool, toolIdentity } from "./lib/tool"

// Attached clients are never OAuth integrations.
const unused = () => Effect.die("unused integration service")

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Tool.node, McpTool.node, Mcp.node, Bus.node]), [
    Location.node.replace(tempLocationLayer),
    Environment.node.replace(hostEnvironmentLayer),
    Integration.node.replace(
      Layer.mock(Integration.Service, {
        revision: () => 0,
        connection: {
          active: unused,
          resolve: unused,
          key: unused,
          external: unused,
          activate: unused,
          update: unused,
          remove: unused,
          status: unused,
        },
        oauth: { connect: unused, status: unused, complete: unused, cancel: unused },
        command: { connect: unused, status: unused, cancel: unused },
      }),
    ),
    Credential.node.replace(Layer.mock(Credential.Service, {})),
    Permission.node.replace(Layer.mock(Permission.Service, { assert: () => Effect.void })),
    Image.node.replace(imagePassthrough),
  ]),
)

/** Starts an in-memory client MCP server whose tools answer with `label` and record the caller's session. */
const clientServer = (label: string, tools: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const server = new McpServer({ name: label, version: "1.0.0" })
    const sessions: Array<unknown> = []
    for (const tool of tools)
      server.registerTool(tool, { description: `${label} ${tool}` }, (ctx) => {
        sessions.push(ctx.mcpReq._meta?.["ai.opencode/sessionID"])
        return { content: [{ type: "text", text: `${label}:${tool}` }] }
      })
    const [client, transport] = InMemoryTransport.createLinkedPair()
    yield* Effect.acquireRelease(
      Effect.promise(() => server.connect(transport)),
      () => Effect.promise(() => server.close()),
    )
    return { server, client, sessions }
  })

const toolsChanged = Effect.gen(function* () {
  const bus = yield* Bus.Service
  const servers: string[] = []
  yield* bus.subscribe(McpEvent.ToolsChanged).pipe(
    Stream.runForEach((event) => Effect.sync(() => servers.push(event.data.server))),
    Effect.forkScoped({ startImmediately: true }),
  )
  return servers
})

const waitUntil = (check: () => boolean) =>
  Effect.suspend(() => (check() ? Effect.void : Effect.fail("pending"))).pipe(
    Effect.retry({ times: 500, schedule: Schedule.spaced("2 millis") }),
  )

/** Waits until the MCP tool registration has (or has not) settled on a registry id. */
const registered = (id: string, present = true) =>
  Effect.gen(function* () {
    const registry = yield* Tool.Service
    const registration = yield* McpTool.Service
    yield* registration.flush
    const ids = (yield* registry.list()).map((tool) => tool.id)
    if (ids.includes(id) !== present) return yield* Effect.fail("pending")
  }).pipe(Effect.retry({ times: 500, schedule: Schedule.spaced("2 millis") }))

// Attached tools use Code Mode by default, like any MCP server's tools.
const call = (path: string, sessionID = Session.ID.make("ses_client_mcp")) =>
  Effect.gen(function* () {
    return yield* executeTool(yield* Tool.Service, {
      sessionID,
      ...toolIdentity,
      call: {
        type: "tool-call",
        id: "call_client_mcp",
        name: "execute",
        input: { code: `return await tools.${path}({})` },
      },
    })
  })

it.live("attaches a client MCP server and routes its tools with the session", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const client = yield* clientServer("tui", ["open_terminal"])

    yield* mcp.attach("tui", client.client)
    yield* waitUntil(() => changes.includes("tui"))
    expect((yield* mcp.tools()).map((tool) => [tool.server, tool.name])).toEqual([["tui", "open_terminal"]])

    yield* registered("tui_open_terminal")
    const result = yield* call("tui.open_terminal", Session.ID.make("ses_attached"))
    expect(result.status).toBe("completed")
    expect(result.output?.output).toBe("tui:open_terminal")
    expect(client.sessions).toEqual(["ses_attached"])
  }),
)

it.live("removes an attached entry when its scope closes", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const client = yield* clientServer("tui", ["open_terminal"])
    const scope = yield* Scope.make()

    yield* mcp.attach("tui", client.client).pipe(Scope.provide(scope))
    yield* registered("tui_open_terminal")
    const before = changes.length

    yield* Scope.close(scope, Exit.void)
    expect(yield* mcp.tools()).toEqual([])
    yield* waitUntil(() => changes.length > before)
    yield* registered("tui_open_terminal", false)
    expect(yield* mcp.callTool({ server: "tui", name: "open_terminal" }).pipe(Effect.flip)).toBeInstanceOf(
      Mcp.NotFoundError,
    )
  }),
)

it.live("removes an attached entry when the client closes the connection", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const changes = yield* toolsChanged
    const client = yield* clientServer("tui", ["open_terminal"])

    yield* mcp.attach("tui", client.client)
    yield* registered("tui_open_terminal")
    const before = changes.length

    yield* Effect.promise(() => client.server.close())
    yield* waitUntil(() => changes.length > before)
    expect(yield* mcp.tools()).toEqual([])
    yield* registered("tui_open_terminal", false)
  }),
)

it.live("replaces an attached entry when the same client attaches again", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const first = yield* clientServer("first", ["old_tool", "shared"])
    const second = yield* clientServer("second", ["shared"])

    yield* mcp.attach("tui", first.client)
    yield* registered("tui_old_tool")
    yield* mcp.attach("tui", second.client)
    expect((yield* mcp.tools()).map((tool) => tool.name)).toEqual(["shared"])
    yield* registered("tui_old_tool", false)

    const result = yield* call("tui.shared")
    expect(result.output?.output).toBe("second:shared")
    expect(first.sessions).toEqual([])
    // The replaced client's connection is closed, not left dangling.
    yield* waitUntil(() => !first.server.isConnected())
  }),
)

it.live("hides attached entries from server status and keeps them across config reconciles", () =>
  Effect.gen(function* () {
    const mcp = yield* Mcp.Service
    const client = yield* clientServer("tui", ["open_terminal"])

    yield* mcp.attach("tui", client.client)
    expect(yield* mcp.servers()).toEqual([])

    // A configured server sharing the client's name neither shows the client nor captures its tools.
    yield* mcp.add("tui", new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))
    yield* mcp.add("other", new ConfigMCP.Local({ type: "local", command: ["unused"], disabled: true }))
    expect((yield* mcp.servers()).map((server) => [server.name, server.status.status])).toEqual([
      ["other", "disabled"],
      ["tui", "disabled"],
    ])
    yield* mcp.remove("tui")
    yield* mcp.reload()
    expect((yield* mcp.servers()).map((server) => server.name)).toEqual(["other"])

    expect((yield* mcp.tools()).map((tool) => [tool.server, tool.name])).toEqual([["tui", "open_terminal"]])
    const result = yield* mcp.callTool({ server: "tui", name: "open_terminal" })
    expect(result.content).toEqual([{ type: "text", text: "tui:open_terminal" }])
  }),
)
