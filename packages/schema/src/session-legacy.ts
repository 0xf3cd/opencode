export * as SessionLegacy from "./session-legacy.js"

/**
 * Storage and wire compatibility for current-architecture data written before v2.1 (not V1 contracts). Native data
 * was then named `state` or `providerState`, a tool's result native data `resultState` or `providerResultState`, and
 * summary compactions stored the text of the messages they kept in `recent`. Stored events, projected messages, and
 * exported transcripts keep whichever shape they were written with, so these upgrade them before decoding.
 */

const renames: Record<string, readonly [string, string]> = {
  "session.text.ended": ["state", "native"],
  "session.reasoning.started": ["state", "native"],
  "session.reasoning.ended": ["state", "native"],
  "session.tool.called": ["state", "native"],
  "session.step.ended": ["providerState", "native"],
  "session.step.failed": ["providerState", "native"],
  "session.tool.success": ["resultState", "native"],
  "session.tool.failed": ["resultState", "native"],
}

/** Upgrades a durable event payload by event type. */
export function event(type: string, data: unknown) {
  if (!isRecord(data)) return data
  if (type === "session.message.content.updated") return content(data)
  // Messages carry a legacy compaction's kept text; its events have no reader for it.
  if (type === "session.compaction.started") return omit(data, "recent")
  if (type === "session.compaction.ended") return omit(rename(data, "providerState", "native"), "recent")
  const entry = renames[type]
  return entry ? rename(data, entry[0], entry[1]) : data
}

/** Upgrades a projected message's data by message type. */
export function message(type: unknown, data: Record<string, unknown>) {
  if (type === "assistant") return content(rename(data, "providerState", "native"))
  if (type === "compaction") return recent(rename(data, "providerState", "native"))
  return data
}

/** Upgrades complete messages, such as those in an exported session, before decoding. */
export function messages(values: ReadonlyArray<unknown>) {
  return values.map((value) => (isRecord(value) ? message(value.type, value) : value))
}

function content(data: Record<string, unknown>) {
  if (!Array.isArray(data.content)) return data
  return { ...data, content: data.content.map(part) }
}

function part(value: unknown) {
  if (!isRecord(value)) return value
  if (value.type === "text" || value.type === "reasoning") return rename(value, "state", "native")
  // A tool part's own `state` is its lifecycle status, not native data.
  if (value.type === "tool") return toolResult(rename(value, "providerState", "native"))
  return value
}

/** Kept text a summary compaction stored before it referenced `metadata.firstKeptMessageID`; replay still reads it. */
function recent(data: Record<string, unknown>) {
  const text = data.recent
  const rest = omit(data, "recent")
  if (typeof text !== "string" || !text) return rest
  const metadata = isRecord(rest.metadata) ? rest.metadata : {}
  return { ...rest, metadata: { recent: text, ...metadata } }
}

function omit(value: Record<string, unknown>, key: string) {
  if (!(key in value)) return value
  const { [key]: _, ...rest } = value
  return rest
}

// Result data now lives on the finished state; an unfinished tool had none to keep.
function toolResult(value: Record<string, unknown>) {
  if (!("providerResultState" in value)) return value
  const { providerResultState, ...rest } = value
  const state = rest.state
  if (!isRecord(state) || (state.status !== "completed" && state.status !== "error") || "native" in state) return rest
  return { ...rest, state: { ...state, native: providerResultState } }
}

// The current name wins when a payload carries both.
function rename(value: Record<string, unknown>, from: string, to: string) {
  if (!(from in value)) return value
  const { [from]: moved, ...rest } = value
  return to in rest ? rest : { ...rest, [to]: moved }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
