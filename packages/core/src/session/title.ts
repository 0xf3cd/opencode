export * as SessionTitle from "./title.js"

import { isDeepStrictEqual } from "node:util"
import { LLMClient, LLMEvent, Message, SystemPart } from "@opencode/ai"
import type { Agent } from "@opencode/schema/agent"
import { Context, DateTime, Effect, Layer, Stream } from "effect"
import { Database } from "../database/database.js"
import { Bus } from "../bus.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { isExactRootFallback } from "@opencode/util/session-title-fallback"
import { llmClient } from "../effect/app-node-platform.js"
import { SessionContext } from "./context.js"
import { SessionEvent } from "./event.js"
import { SessionHistory } from "./history.js"
import type { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionUsage } from "./usage.js"
import { SessionStore } from "./store.js"

const MAX_LENGTH = 100
const MAX_CONTEXT_LENGTH = 8_000
const MAX_FIRST_MESSAGE_LENGTH = 2_000
const titleChanged = Symbol("Session title changed")

export interface Interface {
  /** Generates an initial title or regenerates one from bounded conversation history. */
  readonly generate: (sessionID: SessionSchema.ID) => Effect.Effect<void>
  /** Generates a title only while the session is untitled or still labeled by its first prompt. */
  readonly ensure: (sessionID: SessionSchema.ID) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionTitle") {}

const truncate = (value: string) => (value.length <= MAX_LENGTH ? value : `${value.slice(0, MAX_LENGTH - 3)}...`)
// Labels a session whose title cannot be generated, instead of leaving a timestamped fallback.
const promptTitle = (text: string) => truncate(text.replace(/\s+/g, " ").trim())
const isUntitled = (session: SessionSchema.Info, firstPrompt: string) =>
  session.title === promptTitle(firstPrompt) ||
  isExactRootFallback({
    title: session.title,
    time: { created: DateTime.toEpochMillis(session.time.created) },
  })

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const llm = yield* LLMClient.Service
    const context = yield* SessionContext.Service
    const store = yield* SessionStore.Service
    const db = (yield* Database.Service).db

    const attempt = Effect.fn("SessionTitle.attempt")(function* (input: {
      readonly session: SessionSchema.Info
      readonly agent: Agent.Info
      readonly text: string
      readonly model: SessionRunnerModel.Resolved
    }) {
      const chunks: string[] = []
      let failed = false
      let usage: SessionUsage.Recorded | undefined
      const recordUsage = Effect.suspend(() =>
        usage
          ? bus.publish(SessionEvent.UsageRecorded, {
              sessionID: input.session.id,
              source: "title",
              ...usage,
            })
          : Effect.void,
      )
      const prepared = yield* context.request.title({
        session: input.session,
        agent: input.agent.id,
        model: input.model,
        system: input.agent.system ? [SystemPart.make(input.agent.system)] : [],
        messages: [Message.user(input.text)],
      })
      if (prepared.event.result !== undefined) return prepared.event.result
      yield* llm.stream(prepared.request, prepared.options).pipe(
        Stream.runForEach((event) => {
          if (LLMEvent.is.providerError(event)) failed = true
          if (LLMEvent.is.textDelta(event)) chunks.push(event.text)
          if (LLMEvent.is.stepFinish(event)) {
            const step = SessionUsage.record(event.usage, input.model.cost)
            usage = usage ? SessionUsage.add(usage, step) : step
          }
          return Effect.void
        }),
        Effect.catchTag("AI.Error", () =>
          Effect.sync(() => {
            failed = true
          }),
        ),
        Effect.onInterrupt(() => recordUsage.pipe(Effect.asVoid)),
      )
      yield* recordUsage
      if (failed) return
      return chunks
        .join("")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
    })

    const run = Effect.fnUntraced(function* (sessionID: SessionSchema.ID, untitledOnly: boolean) {
      const session = yield* store.get(sessionID)
      if (!session) return
      const firstUser = yield* SessionHistory.firstUserMessage(db, session.id)
      if (!firstUser) return
      const untitled = isUntitled(session, firstUser.text)
      if (untitledOnly && !untitled) return
      const text = !untitled
        ? yield* store.context(session.id).pipe(
            Effect.map((messages) => {
              const original = `Original request:\n${firstUser.text.slice(0, MAX_FIRST_MESSAGE_LENGTH)}`
              const recent = messages
                .flatMap((message) => {
                  if (message.type === "user" && message.id !== firstUser.id) return [`User: ${message.text.trim()}`]
                  if (message.type !== "assistant") return []
                  const text = message.content
                    .flatMap((part) => (part.type === "text" ? [part.text.trim()] : []))
                    .filter(Boolean)
                    .join("\n")
                  return text ? [`Assistant: ${text}`] : []
                })
                .join("\n\n")
              if (!recent) return original
              const prefix = `${original}\n\nRecent conversation:\n`
              return `${prefix}${recent.slice(-(MAX_CONTEXT_LENGTH - prefix.length))}`
            }),
            Effect.orElseSucceed(() => firstUser.text),
          )
        : firstUser.text
      const selection = yield* context.selectTitle(session)
      const generated = selection
        ? ((yield* attempt({ session, agent: selection.agent, text, model: selection.selected })) ??
          (selection.primary && !isDeepStrictEqual(selection.selected.ref, selection.primary.ref)
            ? yield* attempt({ session, agent: selection.agent, text, model: selection.primary })
            : undefined))
        : undefined
      const title = generated || (untitled ? promptTitle(firstUser.text) : undefined)
      if (!title) return
      const expectedSequence = (yield* Bus.latestSequence(db, sessionID)) + 1
      const current = yield* store.get(sessionID)
      if (!current || current.title !== session.title || current.title === truncate(title)) return
      yield* bus
        .publish(
          SessionEvent.Renamed,
          {
            sessionID: session.id,
            title: truncate(title),
          },
          { commit: (sequence) => (sequence === expectedSequence ? Effect.void : Effect.die(titleChanged)) },
        )
        .pipe(Effect.catchDefect((defect) => (defect === titleChanged ? Effect.void : Effect.die(defect))))
    })
    return Service.of({
      generate: Effect.fn("SessionTitle.generate")((sessionID: SessionSchema.ID) => run(sessionID, false)),
      ensure: Effect.fn("SessionTitle.ensure")((sessionID: SessionSchema.ID) => run(sessionID, true)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Bus.node, llmClient, SessionContext.node, SessionStore.node, Database.node],
})
