export * as TodoTool from "./todo.js"

import { Message, ToolFailure } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import { Effect, Option, Schema } from "effect"
import { Config } from "../../config.js"
import { ConfigEntryObserver } from "../../config/plugin/entry-observer.js"
import { Permission } from "../../permission.js"
import { Session } from "../../session.js"
import DESCRIPTION from "../todowrite.txt"

export const name = "todowrite"
export const REMINDER = "todo.reminder"

export const Info = Schema.Struct({
  content: Schema.String.annotate({ description: "Brief description of the task" }),
  status: Schema.Literals(["pending", "in_progress", "completed", "cancelled"]).annotate({
    description: "Current status of the task: pending, in_progress, completed, cancelled",
  }),
  priority: Schema.Literals(["high", "medium", "low"])
    .pipe(Schema.optional)
    .annotate({ description: "Optional priority level of the task: high, medium, low" }),
})
export type Info = typeof Info.Type

export const Input = Schema.Struct({
  todos: Schema.Array(Info).annotate({ description: "The updated todo list" }),
})

export const Output = Schema.Struct({
  todos: Schema.Array(Info),
})
export type Output = typeof Output.Type

const decodeInput = Schema.decodeUnknownOption(Input)

export const summarize = (todos: ReadonlyArray<Info>) => {
  if (todos.length === 0) return "Todos cleared"
  const count = (status: Info["status"]) => todos.filter((todo) => todo.status === status).length
  const counts = [
    `${count("completed")}/${todos.length} completed`,
    ...(["in_progress", "pending", "cancelled"] as const).flatMap((status) =>
      count(status) ? [`${count(status)} ${status.replace("_", " ")}`] : [],
    ),
  ].join(", ")
  const active = todos.filter((todo) => todo.status === "in_progress").map((todo) => JSON.stringify(todo.content))
  return `Todos updated: ${counts}${active.length ? `. In progress: ${active.join(", ")}` : ""}`
}

export const reminder = (todos: ReadonlyArray<Info>) => {
  const closed = (["completed", "cancelled"] as const).flatMap((status) => {
    const count = todos.filter((todo) => todo.status === status).length
    return count ? [`${count} ${status}`] : []
  })
  return [
    "<system-reminder>",
    `The conversation was compacted. Your todo list still has open items${closed.length ? ` (${closed.join(", ")})` : ""}:`,
    ...todos
      .filter((todo) => todo.status === "pending" || todo.status === "in_progress")
      .map((todo) => `- [${todo.status}] ${todo.content}${todo.priority ? ` (${todo.priority})` : ""}`),
    `Continue from this list and keep it current with the ${name} tool.`,
    "</system-reminder>",
  ].join("\n")
}

export const Plugin = {
  id: "opencode.tool.todo",
  effect: Effect.fn("TodoTool.Plugin")(function* (ctx: Context) {
    const config = yield* Config.Service
    const permission = yield* Permission.Service
    const sessions = yield* Session.Service
    // Internal plugins are not re-run on config changes, so reload the tool transform instead.
    const loaded = yield* ConfigEntryObserver.observe(config, ctx.event, ctx.tool.reload())
    const enabled = () => Config.latest(loaded.entries, "experimental")?.todo === true

    yield* ctx.tool
      .transform((editor) => {
        if (!enabled()) return
        editor.add({
          name,
          options: { codemode: false },
          description: DESCRIPTION,
          input: Input,
          output: Output,
          execute: (input, context) =>
            permission
              .assert({
                action: name,
                resources: ["*"],
                save: ["*"],
                sessionID: context.sessionID,
                agent: context.agent,
                source: { type: "tool", messageID: context.messageID, id: context.id },
              })
              .pipe(
                Effect.mapError((error) => new ToolFailure({ message: "Unable to update todos", error })),
                Effect.as({
                  output: { todos: input.todos },
                  content: summarize(input.todos),
                  metadata: { todos: input.todos },
                }),
              ),
        })
      })
      .pipe(Effect.orDie)

    // Compaction can summarize the latest todo list away. Restore open items once per completed compaction.
    const handled = new Map<Session.ID, SessionMessage.ID>()
    yield* ctx.session.hook("context", (event: SessionHooks["context"]) =>
      Effect.gen(function* () {
        if (!enabled()) return
        const visible = yield* sessions.context(event.sessionID)
        const compaction = visible[0]
        if (compaction?.type !== "compaction" || compaction.status !== "completed") return
        if (handled.get(event.sessionID) === compaction.id) return
        handled.set(event.sessionID, compaction.id)
        if (visible.some((message) => latestTodos(message) !== undefined)) return
        const history = yield* sessions.messages({ sessionID: event.sessionID, order: "desc" })
        const todos = history.reduce<ReadonlyArray<Info> | undefined>(
          (found, message) => found ?? latestTodos(message),
          undefined,
        )
        if (!todos?.some((todo) => todo.status === "pending" || todo.status === "in_progress")) return
        const text = reminder(todos)
        // Before the user's prompt, matching where other reminders land.
        const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
        event.messages.splice(at, 0, Message.user(text))
        yield* ctx.session.synthetic({
          sessionID: event.sessionID,
          text,
          metadata: { kind: REMINDER, todos },
          resume: false,
        })
      }).pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to restore todo list after compaction", { sessionID: event.sessionID, error }),
        ),
      ),
    )
  }),
}

function latestTodos(message: SessionMessage.Info): ReadonlyArray<Info> | undefined {
  if (message.type === "synthetic" && message.metadata?.kind === REMINDER)
    return Option.getOrUndefined(decodeInput({ todos: message.metadata.todos }))?.todos
  if (message.type !== "assistant") return undefined
  return message.content.reduceRight<ReadonlyArray<Info> | undefined>(
    (found, part) =>
      found ??
      (part.type === "tool" && part.name === name && part.state.status === "completed"
        ? Option.getOrUndefined(decodeInput(part.state.input))?.todos
        : undefined),
    undefined,
  )
}
