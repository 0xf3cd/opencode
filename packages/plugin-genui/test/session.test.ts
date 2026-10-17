import { describe, expect, test } from "bun:test"
import { Message } from "@opencode/ai"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext, SessionPrompt } from "@opencode/plugin/effect/session"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Agent } from "@opencode/schema/agent"
import { DateTime, Effect, Stream } from "effect"
import { GenUI } from "../src/genui"
import { GenUISession } from "../src/session"

const sessionID = Session.ID.make("ses_genui_test")

/** Registers the plugin's session hooks against stubs. */
const run = async () => {
  const synthetics: string[] = []
  const hooks: {
    prompt?: (input: SessionPrompt) => Effect.Effect<void>
    context?: (input: SessionContext) => Effect.Effect<void>
  } = {}
  const session: Pick<Context["session"], "hook" | "synthetic"> = {
    hook: (name, callback) => {
      // Hook names and callbacks are correlated, but TypeScript does not narrow this generic registration API.
      if (name === "prompt") hooks.prompt = callback as (input: SessionPrompt) => Effect.Effect<void>
      if (name === "context") hooks.context = callback as (input: SessionContext) => Effect.Effect<void>
      return Effect.succeed({ dispose: Effect.void })
    },
    synthetic: (input) => {
      synthetics.push(input.text)
      return Effect.succeed(
        SessionInbox.Synthetic.make({
          id: SessionMessage.ID.make("msg_genui_test"),
          sessionID,
          time: { created: DateTime.makeUnsafe(0) },
          type: "synthetic",
          payload: { text: input.text },
          delivery: "steer",
        }),
      )
    },
  }
  await Effect.runPromise(
    GenUISession.register({ session, event: { subscribe: () => Stream.empty } }).pipe(Effect.scoped),
  )
  const prompt = (metadata?: Record<string, unknown>) =>
    Effect.runPromise(
      hooks.prompt?.({
        sessionID,
        messageID: SessionMessage.ID.make("msg_prompt"),
        prompt: { text: "hi" },
        metadata,
        delivery: "steer",
      }) ?? Effect.void,
    )
  const context = async (messages: Message[]) => {
    const request: SessionContext = {
      sessionID,
      agent: Agent.ID.make("build"),
      model: { id: Model.ID.make("model"), providerID: Provider.ID.make("test") },
      system: [],
      messages,
      tools: { [GenUI.RENDER_TOOL]: { description: "", input: {} }, read: { description: "", input: {} } },
      options: {},
    }
    await Effect.runPromise(hooks.context?.(request) ?? Effect.void)
    return request
  }
  return { synthetics, prompt, context }
}

describe("GenUISession", () => {
  test("adds the system part and offers the render tool without mutating messages or enqueuing synthetics", async () => {
    const plugin = await run()
    await plugin.prompt({ genui: true })
    const initial = [Message.user("Show me the build")]
    const first = await plugin.context([...initial])

    expect(Object.keys(first.tools)).toEqual([GenUI.RENDER_TOOL, "read"])
    expect(first.system.map((part) => part.text)).toEqual([expect.stringContaining(GenUI.RENDER_TOOL)])
    expect(first.system[0]?.text).not.toContain("<system-reminder>")
    expect(first.messages).toEqual(initial)
    expect(plugin.synthetics).toEqual([])
  })

  test("hides the render tool and adds no system part when a prompt comes without generated UI", async () => {
    const plugin = await run()
    await plugin.prompt({ genui: true })
    await plugin.context([Message.user("hi")])
    await plugin.prompt({ genui: false })
    const initial = [Message.user("Text only now")]
    const request = await plugin.context([...initial])

    expect(Object.keys(request.tools)).toEqual(["read"])
    expect(request.system).toEqual([])
    expect(request.messages).toEqual(initial)
    expect(plugin.synthetics).toEqual([])
  })

  test("never offers the render tool or system part to a session the app has not prompted, such as a subagent", async () => {
    const plugin = await run()
    const initial = [Message.user("Search the repo")]
    const request = await plugin.context([...initial])

    expect(Object.keys(request.tools)).toEqual(["read"])
    expect(request.system).toEqual([])
    expect(request.messages).toEqual(initial)
    expect(plugin.synthetics).toEqual([])
  })
})
