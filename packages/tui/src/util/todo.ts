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
