import { describe, expect } from "bun:test"
import { Message } from "@opencode/ai"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { Agent } from "@opencode/core/agent"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Config } from "@opencode/core/config"
import { Image } from "@opencode/core/image"
import { Model } from "@opencode/core/model"
import { Provider } from "@opencode/core/provider"
import { Session } from "@opencode/core/session"
import { SessionMessage } from "@opencode/core/session/message"
import { Tool } from "@opencode/core/tool"
import { TodoTool } from "@opencode/core/tool/plugin/todo"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Document, Info, type Entry } from "@opencode/schema/config"
import { ConfigExperimental } from "@opencode/schema/config/experimental"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { testEffect } from "./lib/effect"
import { imagePassthrough } from "./lib/image"
import { permissionLayer } from "./lib/permission"
import { executeTool, registerToolPlugin, toolDefinitions, toolIdentity } from "./lib/tool"

const sessionID = Session.ID.make("ses_todo_tool_test")
const enabled = new ConfigExperimental.Info({ todo: true })
const todos = [
  { content: "Write tests", status: "in_progress", priority: "high" },
  { content: "Ship it", status: "pending" },
  { content: "Read the code", status: "completed" },
  { content: "Rewrite everything", status: "cancelled", priority: "low" },
] as const

const it = testEffect(AppNodeBuilder.build(Tool.node, [Image.node.replace(imagePassthrough)]))

const setup = (
  experimental: ConfigExperimental.Info | undefined,
  options: { readonly history?: SessionMessage.Info[] } = {},
) =>
  Effect.gen(function* () {
    const history = yield* Ref.make(options.history ?? [])
    const synthetics: {
      sessionID: Session.ID
      text: string
      metadata?: Record<string, unknown>
      resume?: boolean
    }[] = []
    const hooks = new Map<string, (event: SessionHooks["context"]) => Effect.Effect<void>>()
    yield* registerToolPlugin(TodoTool.Plugin, {
      event: { subscribe: () => Stream.never },
      session: {
        hook: (name, callback) =>
          Effect.sync(() => {
            hooks.set(name, callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
            return { dispose: Effect.void }
          }),
        synthetic: (input) =>
          Effect.sync(() => synthetics.push(input)).pipe(
            Effect.andThen(Ref.update(history, (messages) => [...messages, synthetic(input.text, input.metadata)])),
            Effect.as(
              Schema.decodeUnknownSync(SessionInbox.Synthetic)({
                id: SessionMessage.ID.create(),
                sessionID,
                time: { created: 0 },
                type: "synthetic",
                payload: { text: input.text },
                delivery: "steer",
              }),
            ),
          ),
      },
    }).pipe(
      Effect.provide(Layer.mock(Config.Service)({ entries: () => Effect.succeed([document(experimental)]) })),
      Effect.provide(
        Layer.mock(Session.Service)({
          messages: () => Ref.get(history).pipe(Effect.map((messages) => messages.toReversed())),
          context: () =>
            Ref.get(history).pipe(
              Effect.map((messages) => messages.slice(Math.max(0, messages.findLastIndex(isCompaction)))),
            ),
          revert: {
            stage: () => Effect.die("unused revert.stage"),
            clear: () => Effect.die("unused revert.clear"),
            commit: () => Effect.die("unused revert.commit"),
          },
        }),
      ),
      Effect.provide(permissionLayer({ assert: () => Effect.void })),
    )
    const request = () => {
      const event: SessionHooks["context"] = {
        sessionID,
        agent: toolIdentity.agent,
        model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
        system: [],
        messages: [Message.user("continue")],
        tools: {},
        options: {},
      }
      return hooks.get("context")!(event).pipe(Effect.as(event.messages))
    }
    return {
      synthetics,
      request,
      history,
      registry: yield* Tool.Service,
    }
  })

const names = (registry: Tool.Interface) =>
  toolDefinitions(registry).pipe(Effect.map((definitions) => definitions.map((definition) => definition.name)))

const call = (registry: Tool.Interface) =>
  executeTool(registry, {
    sessionID,
    ...toolIdentity,
    call: { type: "tool-call", id: "call-todo", name: TodoTool.name, input: { todos } },
  })

describe("TodoTool", () => {
  it.effect("is absent unless experimental.todo is enabled", () =>
    Effect.gen(function* () {
      expect(yield* names((yield* setup(undefined)).registry)).not.toContain(TodoTool.name)
      expect(yield* names((yield* setup(new ConfigExperimental.Info({ todo: false }))).registry)).not.toContain(
        TodoTool.name,
      )
    }),
  )

  it.effect("registers todowrite on the native tool list and summarizes the update", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(enabled)
      const definition = (yield* toolDefinitions(fixture.registry)).find((tool) => tool.name === TodoTool.name)

      expect(definition?.inputSchema).toHaveProperty("properties.todos.type", "array")
      expect(definition?.inputSchema).toHaveProperty("properties.todos.items.required", ["content", "status"])
      expect(yield* call(fixture.registry)).toEqual({
        status: "completed",
        output: { todos },
        content: [
          {
            type: "text",
            text: 'Todos updated: 1/4 completed, 1 in progress, 1 pending, 1 cancelled. In progress: "Write tests"',
          },
        ],
        metadata: { todos },
      })
    }),
  )
})

describe("TodoTool compaction reminder", () => {
  it.effect("restores open items once after a compaction", () =>
    Effect.gen(function* () {
      const fixture = yield* setup(enabled, { history: [assistant(todos), compaction()] })

      const messages = yield* fixture.request()
      const text = [
        "<system-reminder>",
        "The conversation was compacted. Your todo list still has open items (1 completed, 1 cancelled):",
        "- [in_progress] Write tests (high)",
        "- [pending] Ship it",
        "Continue from this list and keep it current with the todowrite tool.",
        "</system-reminder>",
      ].join("\n")
      expect(messages).toEqual([Message.user(text), Message.user("continue")])
      expect(fixture.synthetics).toEqual([
        { sessionID, text, metadata: { kind: TodoTool.REMINDER, todos }, resume: false },
      ])

      expect(yield* fixture.request()).toEqual([Message.user("continue")])
      expect(fixture.synthetics).toHaveLength(1)
    }),
  )
})

const decodeMessage = Schema.decodeUnknownSync(SessionMessage.Info)

function isCompaction(message: SessionMessage.Info) {
  return message.type === "compaction"
}

function compaction() {
  return decodeMessage({
    id: SessionMessage.ID.create(),
    type: "compaction",
    status: "completed",
    reason: "auto",
    summary: "summary",
    recent: "",
    time: { created: 0, completed: 0 },
  })
}

function assistant(list: ReadonlyArray<TodoTool.Info>) {
  return decodeMessage({
    id: SessionMessage.ID.create(),
    type: "assistant",
    agent: Agent.ID.make("build"),
    model: { providerID: "test", id: "test" },
    content: [
      {
        type: "tool",
        id: "call-todo",
        name: TodoTool.name,
        state: { status: "completed", input: { todos: list }, content: [{ type: "text", text: "ok" }] },
        time: { created: 0 },
      },
    ],
    time: { created: 0 },
  })
}

function synthetic(text: string, metadata: Record<string, unknown> | undefined) {
  return decodeMessage({ id: SessionMessage.ID.create(), type: "synthetic", text, metadata, time: { created: 0 } })
}

function document(experimental: ConfigExperimental.Info | undefined): Entry {
  return new Document({ type: "document", info: new Info(experimental ? { experimental } : {}) })
}
