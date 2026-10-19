import type { ModelRef, SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { Option, Schema } from "effect"

export type AgentProgressState = "starting" | "running" | "needs-you" | "done" | "failed" | "stopped"

export type AgentProgressItem = {
  key: string
  type: "subagent" | "shell"
  state: AgentProgressState
  title: string
  agent?: string
  model?: ModelRef
  sessionID?: string
  // The tool call or shell the timeline reveals when there is no child session to open.
  target: string
  started?: number
  ended?: number
  error?: string
}

export const activeState = (state: AgentProgressState) =>
  state === "starting" || state === "running" || state === "needs-you"

// One row per subagent of `owner`, from its child sessions and the subagent calls in its own messages, plus its
// running background shells. Only the current batch is kept: subagents since the last time none were running.
export function agentProgressItems(input: {
  owner: string
  sessions: readonly SessionInfo[]
  status: (sessionID: string) => "idle" | "running"
  needsYou: (sessionID: string) => boolean
  // The owner's own messages: subagent calls and their completion notices.
  messages: readonly SessionMessageInfo[]
  // A child's failure from its own idle marker, when its messages are loaded.
  childError: (sessionID: string) => string | undefined
  shells: readonly { id: string; label: string; started?: number }[]
}): AgentProgressItem[] {
  const calls = subagentCalls(input.messages)
  const children = input.sessions.filter((info) => info.parentID === input.owner)
  const known = new Set(children.map((info) => info.id))

  const fromSessions = children.map((info): AgentProgressItem => {
    const call = calls.bySession.get(info.id)
    const running = input.status(info.id) === "running"
    // Created but not yet started: no run has ended either.
    const pending = !running && info.outcome === undefined && info.time.idle === undefined && !call?.finished

    const state: AgentProgressState = input.needsYou(info.id)
      ? "needs-you"
      : running || pending
        ? "running"
        : call?.finished === "error" || info.outcome === "failed"
          ? "failed"
          : call?.finished === "cancelled" || info.outcome === "interrupted"
            ? "stopped"
            : "done"

    return {
      key: info.id,
      type: "subagent",
      state,
      title: info.title ?? call?.title ?? info.id,
      agent: info.agent ?? call?.agent,
      model: info.model,
      sessionID: info.id,
      target: call?.partID ?? info.id,
      // The latest call into the child is this run; a resumed child was created long before it.
      started: call?.started ?? info.time.created,
      ended: activeState(state) ? undefined : (info.time.idle ?? call?.ended ?? info.time.updated),
      error: state === "failed" ? (input.childError(info.id) ?? call?.error) : undefined,
    }
  })

  // Calls whose child session this client hasn't loaded, and calls still starting their child.
  const fromCalls = calls.list.flatMap((call): AgentProgressItem[] => {
    if (call.sessionID && known.has(call.sessionID)) return []

    const state: AgentProgressState =
      call.sessionID && input.needsYou(call.sessionID)
        ? "needs-you"
        : call.finished === "error"
          ? "failed"
          : call.finished === "cancelled"
            ? "stopped"
            : call.finished
              ? "done"
              : call.sessionID
                ? "running"
                : "starting"

    return [
      {
        key: call.sessionID ?? call.partID,
        type: "subagent",
        state,
        title: call.title,
        agent: call.agent,
        sessionID: call.sessionID,
        target: call.partID,
        started: call.started,
        ended: activeState(state) ? undefined : call.ended,
        error: call.error,
      },
    ]
  })

  return [
    ...currentBatch([...fromSessions, ...fromCalls]),
    ...input.shells.map(
      (shell): AgentProgressItem => ({
        key: shell.id,
        type: "shell",
        state: "running",
        title: shell.label,
        target: shell.id,
        started: shell.started,
      }),
    ),
  ]
}

// The subagents since the last moment none was running, in start order.
export function currentBatch(items: readonly AgentProgressItem[]) {
  const sorted = items.toSorted((a, b) => (a.started ?? Infinity) - (b.started ?? Infinity))

  const reach = (item: AgentProgressItem) =>
    activeState(item.state) ? Infinity : (item.ended ?? item.started ?? Infinity)

  const start = sorted.reduce(
    (acc, item, index) => {
      const begins = index > 0 && (item.started ?? Infinity) > acc.reach

      return { start: begins ? index : acc.start, reach: Math.max(begins ? -Infinity : acc.reach, reach(item)) }
    },
    { start: 0, reach: -Infinity },
  ).start

  return sorted.slice(start)
}

export type AgentProgressCounts = {
  total: number
  running: number
  needsYou: number
  failed: number
  done: number
}

export function agentProgressCounts(items: readonly AgentProgressItem[]): AgentProgressCounts {
  return {
    total: items.length,
    running: items.filter((item) => item.state === "running" || item.state === "starting").length,
    needsYou: items.filter((item) => item.state === "needs-you").length,
    failed: items.filter((item) => item.state === "failed").length,
    done: items.filter((item) => item.state === "done" || item.state === "stopped").length,
  }
}

type SubagentCall = {
  partID: string
  sessionID?: string
  title: string
  agent?: string
  started: number
  ended?: number
  finished?: "completed" | "error" | "cancelled"
  error?: string
}

// Subagent tool calls in the owner's messages, settled by their own result (foreground) or by the completion notice
// a background subagent posts to its parent.
function subagentCalls(messages: readonly SessionMessageInfo[]) {
  const notices = new Map(
    messages.flatMap((message) => {
      if (message.type !== "synthetic") return []

      return Option.match(decodeNotice(message.metadata), {
        onNone: () => [],
        onSome: (notice) => {
          const finished = notice.state === "error" || notice.state === "cancelled" ? notice.state : "completed"

          return [
            [
              notice.childID,
              { finished, ended: message.time.created, error: noticeError(message.text, finished) },
            ] as const,
          ]
        },
      })
    }),
  )

  const list = messages.flatMap((message) =>
    message.type !== "assistant"
      ? []
      : message.content.flatMap((part): SubagentCall[] => {
          if (part.type !== "tool" || part.name !== "subagent") return []
          const input = Option.getOrUndefined(decodeCallInput(part.state.input))

          const metadata = Option.getOrUndefined(
            decodeCallMetadata(part.state.status === "streaming" ? undefined : part.state.metadata),
          )

          const sessionID = metadata?.sessionID
          const notice = sessionID ? notices.get(sessionID) : undefined
          // A background call completes at once with `status: "running"`; its notice settles it later.
          const background = part.state.status === "completed" && metadata?.status === "running"
          const settled = part.state.status === "error" || (part.state.status === "completed" && !background)

          return [
            {
              partID: part.id,
              sessionID,
              title: input?.description ?? sessionID ?? part.id,
              agent: input?.agent,
              started: part.time.created,
              ended: background ? notice?.ended : (part.time.completed ?? notice?.ended),
              finished: settled ? (part.state.status === "error" ? "error" : "completed") : notice?.finished,
              error: part.state.status === "error" ? part.state.error.message : notice?.error,
            },
          ]
        }),
  )

  return { list, bySession: new Map(list.flatMap((call) => (call.sessionID ? [[call.sessionID, call]] : []))) }
}

const decodeNotice = Schema.decodeUnknownOption(
  Schema.Struct({
    source: Schema.Literal("subagent"),
    childID: Schema.String,
    state: Schema.optional(Schema.String),
  }),
)

const decodeCallInput = Schema.decodeUnknownOption(
  Schema.Struct({ description: Schema.optional(Schema.String), agent: Schema.optional(Schema.String) }),
)

const decodeCallMetadata = Schema.decodeUnknownOption(
  Schema.Struct({ sessionID: Schema.optional(Schema.String), status: Schema.optional(Schema.String) }),
)

// The notice wraps the failure as `<subagent …>\n{error}\n</subagent>`.
function noticeError(text: string, finished: string) {
  if (finished !== "error") return

  return text.match(/^<subagent[^>]*>\n([\s\S]*)\n<\/subagent>$/)?.[1]?.trim() || undefined
}

export function formatElapsed(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000))

  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)

  if (minutes < 60) return `${minutes}m ${seconds % 60}s`

  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}
