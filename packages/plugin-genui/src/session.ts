export * as GenUISession from "./session.js"

import { SystemPart } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { GenUI } from "./genui.js"

const instructions = `The user is viewing this session in the OpenCode app. For the occasional answer that is clearly better seen or clicked than read, such as a dashboard, a chart of real data or a form, ${GenUI.RENDER_TOOL} draws interactive UI while you write it; load the genui skill first. Answer everything else in text as usual. When the in-app browser is connected, its tools are in your tool list and the browser skill explains them.`

/**
 * Offers the render tool, and tells the agent it may use it, only while the user can see generated UI: the app marks
 * its prompts with `metadata.genui = true` while the setting is on, so the latest prompt decides.
 */
export const register = Effect.fn("GenUISession.register")(function* (ctx: {
  readonly session: Pick<Context["session"], "hook">
  readonly event: Context["event"]
}) {
  // In memory only: after a restart a session counts as unknown until its next prompt.
  const available = new Map<Session.ID, boolean>()

  yield* ctx.session.hook("prompt", (event) =>
    Effect.sync(() => {
      available.set(event.sessionID, event.metadata?.genui === true)
    }),
  )

  yield* ctx.session.hook("context", (event) =>
    Effect.sync(() => {
      if (available.get(event.sessionID) !== true) {
        delete event.tools[GenUI.RENDER_TOOL]
        return
      }
      event.system.push(SystemPart.make(instructions))
    }),
  )

  yield* ctx.event.subscribe().pipe(
    Stream.filter((event) => event.type === "session.deleted"),
    Stream.runForEach((event) =>
      Effect.sync(() => {
        available.delete(event.data.sessionID)
      }),
    ),
    Effect.forkScoped({ startImmediately: true }),
  )
})
