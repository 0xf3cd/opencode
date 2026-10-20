import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js"
import type { SessionInfo } from "@opencode/client/promise"
import { useGlobal, useServerCtx } from "@/runtime/server/runtime"
import { sessionPermissionRequest, sessionFormRequest } from "@/session/requests/session-request-tree"
import { ServerConnection } from "@/runtime/server/registry"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { agentOrbState, lastOutcome, runningStep } from "./agent-orb-state"

// How long Done or Failed shows once the session goes quiet, like the iOS Working line's finale.
const FINALE_MS = 2600

type ServerData = ReturnType<ReturnType<typeof useGlobal>["ensureServerCtx"]>["data"]

export function useSessionTabAvatarState(
  server: Accessor<ServerConnection.Key>,
  sessionId: Accessor<string>,
  root?: Accessor<boolean>,
  snapshot?: Accessor<SessionInfo | undefined>,
) {
  const global = useGlobal()
  const settings = useSettings()
  const connection = createMemo(() => global.servers.list().find((item) => ServerConnection.key(item) === server()))
  const serverCtx = useServerCtx(connection)

  const requests = createMemo(() => {
    const ctx = serverCtx()

    if (!ctx) return { permission: false, form: false }

    const project = projectSettingsKey(ctx.sdk.scope, ctx.data.session.get(sessionId())?.projectID)

    return sessionRequests(ctx.data, sessionId(), !!root?.(), settings.permissions.autoApproves(project))
  })

  const needsAttention = createMemo(() => requests().permission || requests().form)

  const unread = createMemo(
    () => needsAttention() || (serverCtx()?.notification.session.unread(sessionId(), snapshot?.()) ?? false),
  )

  const loading = createMemo(() => {
    const data = serverCtx()?.data

    if (!data) return false

    if (needsAttention()) return false

    if (root?.())
      return data.session
        .list()
        .some((session) => data.session.root(session.id) === sessionId() && sessionBusy(data, session.id))

    return sessionBusy(data, sessionId())
  })

  // Undefined when the classic indicator is selected.
  const work = createMemo(() => {
    const data = serverCtx()?.data

    if (!data || settings.appearance.agentStatus() !== "orb") return undefined
    const id = sessionId()

    return {
      attention: needsAttention(),
      running: sessionBusy(data, id),
      step: runningStep(data.session.message.list(id)),
      subagents: !!root?.() && data.session.family(id).some((child) => child !== id && sessionBusy(data, child)),
      shells: data.shell.listBySession(id).some((shell) => shell.status === "running"),
    }
  })

  // A memo, so the finale starts only when work actually stops, not on every transcript change.
  const working = createMemo(() => {
    const current = work()

    return !!current && (current.running || current.subagents || current.shells)
  })

  const [finale, setFinale] = createSignal(false)
  let timer: ReturnType<typeof setTimeout> | undefined

  createEffect(
    on(working, (active, previous) => {
      clearTimeout(timer)
      setFinale(!active && !!previous)

      if (!active && previous) timer = setTimeout(() => setFinale(false), FINALE_MS)
    }),
  )
  onCleanup(() => clearTimeout(timer))

  const activity = createMemo(() => {
    const current = work()

    if (!current) return undefined
    const data = serverCtx()?.data

    const outcome =
      data && (lastOutcome(data.session.message.list(sessionId())) ?? data.session.get(sessionId())?.outcome)

    return agentOrbState({ ...current, finished: finale() ? (outcome ?? "succeeded") : undefined })
  })

  return { unread, loading, activity }
}

// Pending permission and form requests anywhere in the session (or its family, for roots).
export function sessionRequests(data: ServerData, sessionId: string, root: boolean, autoApprove: boolean) {
  const sessions = root
    ? [...new Set([sessionId, ...data.session.family(sessionId)])].flatMap((id) => {
        const info = data.session.get(id)

        return info ? [info] : []
      })
    : data.session.list()

  return {
    permission: !autoApprove && !!sessionPermissionRequest(sessions, data.session.permission.list, sessionId),
    form: !!sessionFormRequest(sessions, data.session.form.list, sessionId),
  }
}

// Like the TUI, work waiting in the inbox counts as busy; parked synthetic context does not.
export function sessionBusy(data: ServerData, sessionId: string) {
  return (
    data.session.status(sessionId) === "running" ||
    data.session.pending.list(sessionId).some((item) => item.type !== "synthetic")
  )
}
