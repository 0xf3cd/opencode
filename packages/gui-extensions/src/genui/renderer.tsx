import { createMemo, lazy, onCleanup, Suspense } from "solid-js"
import { Icon } from "@opencode/ui/icon"
import { Command, createKeyed, onIdle, Panel, Style, type PanelTab, type Setup } from "../sdk"
import type definition from "./index"
import { createGenUI } from "./model"

// In side panel mode the timeline keeps each surface's header row and points at the panel.
const panelStyle = `
  [data-component="genui-inline"] [data-slot="genui-inline-body"] { display: none; }
  [data-component="genui-inline"] [data-slot="genui-inline-panel"] { display: inline; }
`

const setup: Setup<typeof definition> = (ctx) => {
  const GenUIPanel = lazy(() => import("./panel"))
  onCleanup(onIdle(() => void GenUIPanel.preload()))
  const layout = ctx.layout
  const sessions = ctx.sessions
  const placement = ctx.stores.placement
  const genui = createGenUI(ctx)
  const panel = () => placement.value.placement === "panel"

  ctx.add(Style, () => (panel() ? panelStyle : undefined))

  ctx.add(
    Command,
    (): Command => ({
      id: "placement",
      title: panel() ? ctx.t("command.timeline") : ctx.t("command.panel"),
      group: ctx.t("command.category.view"),
      run: () => placement.set({ placement: panel() ? "timeline" : "panel" }),
    }),
  )

  // In side panel mode, a surface the agent starts writing opens as a tab and streams there.
  const live = createMemo(() => {
    const session = sessions.current()

    if (!session || !panel()) return undefined
    const surface = genui.surfaces(session).findLast((item) => item.live)

    return surface ? { session, id: surface.id } : undefined
  })

  createKeyed(live, (value) => layout.open(`${ctx.id}:${value.id}`, value.session, { background: true, tab: "select" }), {
    equals: (previous, next) => previous.session.key === next.session.key && previous.id === next.id,
  })

  // Tab objects per session, reused so strip updates and session switches do not rebuild a trigger.
  const tabs = new Map<string, Map<string, PanelTab>>()

  // Drops the tab objects of sessions whose shell tab closed.
  createKeyed(
    () => [...sessions.list().map((session) => session.key), sessions.current()?.key].join("\u0000"),
    () => {
      const keep = new Set([...sessions.list().map((session) => session.key), sessions.current()?.key])
      tabs.forEach((_cache, key) => {
        if (!keep.has(key)) tabs.delete(key)
      })
    },
  )

  ctx.add(Panel, {
    id: "main",
    region: "side",
    // One tab per surface. A tab stays listed, hidden, until the session's messages name its surface.
    list: (input) => {
      if (input.open.length === 0) return []

      const cache = tabs.get(input.session.key) ?? new Map<string, PanelTab>()
      tabs.set(input.session.key, cache)

      return input.open.map((id) => {
        const existing = cache.get(id)

        if (existing) return existing
        const surface = () => genui.surfaces(input.session).find((item) => item.id === id)
        const title = () => surface()?.title || ctx.t("tab.title")

        const tab: PanelTab = {
          id,
          get title() {
            return title()
          },
          get hidden() {
            return !surface()
          },
          label: () => (
            <div class="flex min-w-0 items-center gap-1.5">
              <Icon name="window-analytics" size="small" />
              <span class="max-w-40 truncate">{title()}</span>
            </div>
          ),
        }

        cache.set(id, tab)

        return tab
      })
    },
    render: (props) => (
      <Suspense>
        <GenUIPanel model={genui} session={props.session} id={props.tab.id} />
      </Suspense>
    ),
    close: (input) => tabs.get(input.session.key)?.delete(input.tab.id),
  })
}

export default setup
