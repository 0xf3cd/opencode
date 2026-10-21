import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { Schema } from "effect"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Persistence } from "@/runtime/persistence/schema"

export const SNAPSHOT_MESSAGE_LIMIT = 20

const isSessionInfo = Schema.is(Schema.toEncoded(Session.Info))

const isSessionMessageInfo = Schema.is(Schema.toEncoded(SessionMessage.Info))

const SessionInfoSnapshot = Schema.declare<SessionInfo>((value): value is SessionInfo => isSessionInfo(value), {
  toCodecJson: () => undefined,
})

const SessionMessageSnapshot = Schema.declare<SessionMessageInfo>(
  (value): value is SessionMessageInfo => isSessionMessageInfo(value),
  {
    toCodecJson: () => undefined,
  },
)

export const SessionSnapshot = Persistence.struct({
  info: SessionInfoSnapshot,
  messages: Persistence.array(SessionMessageSnapshot),
})

export const SessionSnapshots = Schema.Record(
  Schema.String,
  Schema.mutableKey(Persistence.fallback(Schema.UndefinedOr(SessionSnapshot), () => undefined)),
)

export type SessionSnapshotEntry = typeof SessionSnapshot.Type

function messageRevision(message: SessionMessageInfo | undefined) {
  if (!message) return ""

  if (message.type === "assistant") {
    return `${message.id}:${message.finish ?? ""}:${message.time.streamed ?? 0}:${message.time.completed ?? 0}:${message.content.length}`
  }

  if (message.type === "shell") {
    return `${message.id}:${message.status}:${message.time.completed ?? 0}`
  }

  if (message.type === "compaction") {
    return `${message.id}:${message.status}`
  }

  return `${message.id}:${message.time.created}`
}

export function sameSessionSnapshot(
  current: SessionSnapshotEntry | undefined,
  info: SessionInfo,
  messages: SessionMessageInfo[],
) {
  if (!current) return false

  if (
    current.info.id !== info.id ||
    current.info.title !== info.title ||
    current.info.location.directory !== info.location.directory ||
    current.info.time.updated !== info.time.updated ||
    current.info.agent !== info.agent ||
    current.info.model?.providerID !== info.model?.providerID ||
    current.info.model?.id !== info.model?.id ||
    current.info.revert?.messageID !== info.revert?.messageID ||
    current.messages.length !== messages.length
  )
    return false

  return (
    current.messages[0]?.id === messages[0]?.id &&
    messageRevision(current.messages.at(-1)) === messageRevision(messages.at(-1))
  )
}
