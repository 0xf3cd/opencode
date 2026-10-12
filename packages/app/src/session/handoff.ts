import type { SessionMessageUser } from "@opencode/client/promise"
import { createStore } from "solid-js/store"
import type { ServerSDK } from "@/runtime/server/client"

const MAX = 40

const [messages, setMessages] = createStore<Record<string, SessionMessageUser | undefined>>({})

const messageOrder = new Map<string, true>()

export const setSessionMessageHandoff = (key: string, message: SessionMessageUser) => {
  messageOrder.delete(key)
  messageOrder.set(key, true)
  setMessages(key, message)

  while (messageOrder.size > MAX) {
    const first = messageOrder.keys().next().value

    if (first === undefined) return
    messageOrder.delete(first)
    setMessages(first, undefined)
  }
}

export const getSessionMessageHandoff = (key: string) => messages[key]

export const clearSessionMessageHandoff = (key: string, messageID: string) => {
  if (messages[key]?.id !== messageID) return
  messageOrder.delete(key)
  setMessages(key, undefined)
}

export function createSessionMessageHandoff(key: string, sessionID: string, event: ServerSDK["event"]) {
  let unsubscribe: VoidFunction | undefined

  return {
    set(message: SessionMessageUser) {
      unsubscribe?.()
      setSessionMessageHandoff(key, message)
      unsubscribe = event.on("session.inbox.enqueued", (item) => {
        if (item.data.sessionID !== sessionID || item.data.inboxID !== message.id) return
        unsubscribe?.()
        unsubscribe = undefined
        clearSessionMessageHandoff(key, message.id)
      })
    },
    clear(messageID: string) {
      unsubscribe?.()
      unsubscribe = undefined
      clearSessionMessageHandoff(key, messageID)
    },
  }
}
