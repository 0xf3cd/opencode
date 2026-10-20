import { connectClientMcp, sessionID, type ClientMcpConnection } from "@opencode/client/mcp"
import { createEffect, onCleanup } from "solid-js"
import { useConfig } from "../config"
import { createSimpleContext } from "./helper"
import { useClient } from "./client"
import { useData } from "./data"
import { useRoute } from "./route"
import { useSessionTabs } from "./session-tabs"
import { useSessionTerminals } from "./session-terminals"

// Serves TUI tools to the server as the client MCP server "tui", so the model sees them as `tui_<tool>`.
export const { provider: ClientMcpProvider } = createSimpleContext({
  name: "ClientMcp",
  init: () => {
    const client = useClient()
    const config = useConfig()
    const data = useData()
    const route = useRoute()
    const tabs = useSessionTabs()
    const terminals = useSessionTerminals()
    const state: { key?: string; connection?: ClientMcpConnection } = {}

    const openTerminal = async (calledBy: string | undefined) => {
      if (!calledBy || !data.session.get(calledBy)) return failure("Unknown session")
      if (!terminals.available()) return failure("This server does not support terminals")
      const root = data.session.root(calledBy)
      const routed = route.data.type === "session" ? route.data.sessionID : undefined
      // Terminals belong to the session the user is looking at, which may be the caller's family root.
      const target =
        routed && data.session.root(routed) === root
          ? routed
          : tabs.enabled() && tabs.tabs().some((tab) => tab.sessionID === root)
            ? root
            : undefined
      if (!target) return failure("session not open in this TUI")
      await terminals.refresh(target)
      const last = terminals.get(target).terminals.at(-1)
      if (last) await terminals.selectTerminal(target, last.id)
      const ptyID = last?.id ?? (await terminals.newTerminal(target)).id
      return { content: [{ type: "text" as const, text: `Opened terminal ${ptyID}` }] }
    }

    // Reconnects when the flag flips or the server endpoint changes after a service reconnect.
    const sync = () => {
      const url = client.url
      const enabled = config.data.experimental?.["client-mcp"] === true
      const key = enabled && url ? JSON.stringify([url, client.headers]) : undefined
      if (key === state.key) return
      void state.connection?.close()
      state.key = key
      state.connection =
        key && url
          ? connectClientMcp({
              url,
              name: "tui",
              directory: data.location.default().directory,
              headers: client.headers,
              register(server) {
                server.registerTool(
                  "open_terminal",
                  { description: "Open a terminal for the current session in the user's TUI" },
                  (ctx) => openTerminal(sessionID(ctx)),
                )
              },
            })
          : undefined
    }

    createEffect(sync)
    onCleanup(client.event.on("server.connected", sync))
    onCleanup(() => {
      state.key = undefined
      void state.connection?.close()
    })

    return {}
  },
})

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true }
}
