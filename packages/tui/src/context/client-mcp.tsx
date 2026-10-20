import { connectClientMcp, sessionID, type ClientMcpConnection } from "@opencode/client/mcp"
import { createEffect, onCleanup, untrack } from "solid-js"
import { useClientMcpExperiment } from "../config"
import { useClient } from "./client"
import { useData } from "./data"
import { useRoute } from "./route"
import { useSessionTabs } from "./session-tabs"
import { useSessionTerminals } from "./session-terminals"

// Serves TUI tools to the server as the client MCP server "tui", so the model sees them as `tui_<tool>`.
export function ClientMcp() {
  const client = useClient()
  const enabled = useClientMcpExperiment()
  const data = useData()
  const route = useRoute()
  const tabs = useSessionTabs()
  const terminals = useSessionTerminals()
  const state: { key?: string; connection?: ClientMcpConnection } = {}

  const openTerminal = async (calledBy: string | undefined) => {
    if (!calledBy) return failure("Unknown session")
    if (!data.session.get(calledBy)) await data.session.sync(calledBy).catch(() => undefined)
    if (!data.session.get(calledBy)) return failure("Unknown session")
    if (!terminals.available()) return failure("This server does not support terminals")
    const root = data.session.root(calledBy)
    const routed = route.data.type === "session" ? route.data.sessionID : undefined
    // Terminal panes render for the routed session; tabs hold root sessions, which become routed when selected.
    const target =
      routed && data.session.root(routed) === root
        ? routed
        : tabs.enabled() && tabs.tabs().some((tab) => tab.sessionID === root)
          ? root
          : undefined
    if (!target) return failure("session not open in this TUI")
    await terminals.refresh(target)
    // The agent opened it, so don't move the user's keyboard focus into a live shell.
    const last = terminals.get(target).terminals.at(-1)
    if (last) await terminals.selectTerminal(target, last.id, { focus: false })
    const ptyID = last?.id ?? (await terminals.newTerminal(target, { focus: false })).id
    return { content: [{ type: "text" as const, text: `Opened terminal ${ptyID}` }] }
  }

  // Reconnects when the flag flips or the server endpoint changes after a service reconnect.
  const sync = () => {
    const url = client.url
    const directory = data.location.default().directory
    const key = enabled() && url ? JSON.stringify([url, client.headers, directory]) : undefined
    if (key === state.key) return
    void state.connection?.close()
    state.key = key
    state.connection =
      key && url
        ? untrack(() =>
            connectClientMcp({
              url,
              name: "tui",
              directory,
              headers: client.headers,
              register(server) {
                server.registerTool(
                  "open_terminal",
                  {
                    description:
                      "Open a terminal for the current session in the user's TUI, without taking keyboard focus. The pane may stay hidden if the user has a panel or the sidebar open.",
                  },
                  (ctx) => openTerminal(sessionID(ctx)),
                )
              },
            }),
          )
        : undefined
  }

  createEffect(sync)
  onCleanup(client.event.on("server.connected", sync))
  onCleanup(() => {
    state.key = undefined
    void state.connection?.close()
  })

  return null
}

function failure(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true }
}
