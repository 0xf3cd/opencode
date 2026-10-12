export * as GenUISession from "./session.js"

import { Message } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { GenUI } from "./genui.js"

const enter = `<system-reminder>
The user is viewing this session in the OpenCode app. ${GenUI.RENDER_TOOL} shows them interactive UI, such as dashboards, charts and forms, drawn while you write it; load the genui skill for its syntax first. App-only tools such as the browser are in your tool list when they are available.
</system-reminder>`

const leave = `<system-reminder>
The user is no longer viewing this session in the OpenCode app, so ${GenUI.RENDER_TOOL} is unavailable. Answer in text.
</system-reminder>`

/**
 * Offers the render tool, and tells the agent it may use it, only while the user is in the app: the app marks its
 * prompts with `metadata.client = "app"`, so the latest prompt shows where the user is.
 */
export const register = Effect.fn("GenUISession.register")(function* (ctx: {
  readonly session: Pick<Context["session"], "hook" | "synthetic">
  readonly event: Context["event"]
}) {
  // In memory only: after a restart a session counts as unknown, not left, until its next prompt.
  const app = new Map<Session.ID, boolean>()

  yield* ctx.session.hook("prompt", (event) =>
    Effect.sync(() => {
      app.set(event.sessionID, event.metadata?.client === "app")
    }),
  )

  yield* ctx.session.hook("context", (event) => {
    const viewing = app.get(event.sessionID)
    if (viewing !== true) delete event.tools[GenUI.RENDER_TOOL]
    const reminder = lastReminder(event.messages)
    const text =
      viewing === true && reminder !== enter ? enter : viewing === false && reminder === enter ? leave : undefined
    if (!text) return Effect.void
    // Before the user's prompt and near the tail, like Plan mode's reminders, so the cached prefix stays warm.
    const at = event.messages.at(-1)?.role === "user" ? event.messages.length - 1 : event.messages.length
    event.messages.splice(at, 0, Message.user(text))
    return ctx.session
      .synthetic({ sessionID: event.sessionID, text, resume: false })
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to persist the GenUI reminder", { sessionID: event.sessionID, cause }),
        ),
      )
  })

  yield* ctx.event.subscribe().pipe(
    Stream.filter((event) => event.type === "session.deleted"),
    Stream.runForEach((event) =>
      Effect.sync(() => {
        app.delete(event.data.sessionID)
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
})

function lastReminder(messages: ReadonlyArray<Message>) {
  return messages.reduce<string | undefined>((found, message) => {
    const part = message.role === "user" && message.content.length === 1 ? message.content[0] : undefined
    if (part?.type !== "text") return found
    return part.text === enter || part.text === leave ? part.text : found
  }, undefined)
}
