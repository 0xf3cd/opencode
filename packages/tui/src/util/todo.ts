import type {
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageToolStateCompleted,
} from "@opencode/client"
import { isRecord } from "./record"

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled"

export type Todo = {
  content: string
  status: TodoStatus
}

const statuses = new Set<unknown>(["pending", "in_progress", "completed", "cancelled"])

export function parseTodos(value: unknown): Todo[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item) || typeof item.content !== "string" || !item.content) return []
    return [{ content: item.content, status: statuses.has(item.status) ? (item.status as TodoStatus) : "pending" }]
  })
}

export function todoMarker(status: TodoStatus, ascii = false) {
  if (status === "completed") return ascii ? "[x]" : "[✓]"
  if (status === "in_progress") return ascii ? "[>]" : "[•]"
  if (status === "cancelled") return "[-]"
  return "[ ]"
}

/**
 * The current list is the latest completed `todowrite` input or post-compaction todo reminder,
 * after the latest completed compaction and before the revert boundary. An empty list means none.
 */
export function sessionTodos(messages: ReadonlyArray<SessionMessageInfo>, boundary?: string): Todo[] {
  const boundaryIndex = boundary ? messages.findIndex((message) => message.id === boundary) : -1
  const visible = messages.slice(0, boundaryIndex === -1 ? messages.length : boundaryIndex)
  const compaction = visible.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const source = visible
    .slice(compaction + 1)
    .flatMap((message) => {
      if (message.type === "synthetic" && message.metadata?.kind === "todo.reminder") return [message.metadata.todos]
      if (message.type !== "assistant") return []
      return message.content
        .filter(
          (item): item is SessionMessageAssistantTool & { state: SessionMessageToolStateCompleted } =>
            item.type === "tool" && item.name === "todowrite" && item.state.status === "completed",
        )
        .map((item) => item.state.input.todos)
    })
    .at(-1)
  return parseTodos(source)
}
