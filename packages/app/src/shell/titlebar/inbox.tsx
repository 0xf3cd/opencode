import { isSessionNotFoundError, type SessionInfo } from "@opencode/client/promise"
import { useQueries, useQueryClient } from "@tanstack/solid-query"
import { Schema } from "effect"
import { Persistence } from "@/runtime/persistence/schema"
import { createStore } from "solid-js/store"
import { createEffect, createMemo, createSignal, For, onCleanup, Show, startTransition, type JSX } from "solid-js"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Dialog, DialogFooter, DialogHeader, DialogTitleGroup } from "@opencode/ui/dialog"
import { Icon } from "@opencode/ui/icon"
import { Menu } from "@opencode/ui/menu"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { Tooltip } from "@opencode/ui/tooltip"
import { displayName } from "@opencode/ui/project-avatar"
import { useGlobal } from "@/runtime/server/runtime"
import { ServerConnection, serverName, useServers } from "@/runtime/server/registry"
import { useLanguage } from "@/runtime/i18n/language"
import { useCommand } from "@/shell/commands/command"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { projectSettingsKey, useSettings } from "@/settings/model"
import { useLayout } from "@/shell/state/layout"
import { useTabs } from "@/shell/tabs/tabs"
import { sessionBusy, sessionRequests } from "@/shell/layout/project-avatar-state"
import { SessionTabAvatarView } from "@/shell/layout/session-tab-avatar"
import { pathKey } from "@/workspaces/path-key"
import { sessionTabTitle } from "./tab-title"
import { notifySessionTabsRemoved } from "./session-events"
import { loadHomeSessionIndex } from "@/home/sessions/index"
import { archiveHomeSession } from "@/home/sessions/archive"
import { sessionTreeIDs } from "@/session/requests/session-request-tree"
import { sessionTitle } from "@/session/title"
import { errorMessage } from "@/shell/layout/helpers"
import { showToast } from "@/shell/notifications/toast"

// Keep the immutable result opaque so Solid Query does not recursively unwrap every session.
const selectSessions = (sessions: SessionInfo[]) => () => sessions

// Branch lookups each run git on the server, so load them a few at a time.
const BRANCH_BATCH = 4

// The Home index excludes archived sessions, so the inbox loads the newest archived ones separately.
const ARCHIVED_LIMIT = 50

// `since` is when the inbox was first used; Recent only lists sessions that finished a run after it.
const InboxState = Persistence.struct({
  workingExpanded: Schema.Boolean,
  since: Persistence.optional(Schema.Number),
})

type InboxStatus = "approval" | "input" | "working" | "failed" | "done" | "ready"

type InboxEntry = {
  key: string
  conn: ServerConnection.Any
  server: ServerConnection.Key
  ctx: ReturnType<ReturnType<typeof useGlobal>["ensureServerCtx"]>
  session: SessionInfo
  status: InboxStatus
}

export function SidebarInbox() {
  const global = useGlobal()
  const servers = useServers()
  const settings = useSettings()
  const layout = useLayout()
  const tabs = useTabs()
  const language = useLanguage()
  const dialog = useDialog()
  const command = useCommand()
  let root!: HTMLDivElement

  const [state, setState, , ready] = persisted(Persist.global("sidebar.inbox"), InboxState, {
    workingExpanded: true,
  })

  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), 1_000)
  onCleanup(() => clearInterval(timer))

  const queryClient = useQueryClient()
  const connections = createMemo(() => servers.visible.map((conn) => ({ conn, ctx: global.ensureServerCtx(conn) })))

  // The inbox stays mounted and rarely refetches the index, so drop sessions the server no longer has.
  const forget = (conn: ServerConnection.Any, sessionID: string) => {
    queryClient.setQueryData<SessionInfo[]>(["home-sessions", conn], (current) =>
      current?.filter((session) => session.id !== sessionID),
    )
    queryClient.setQueryData<SessionInfo[]>(["inbox-archived-sessions", conn], (current) =>
      current?.filter((session) => session.id !== sessionID),
    )
  }

  createEffect(() => {
    connections().forEach((item) => {
      onCleanup(item.ctx.data.on("session.deleted", (event) => forget(item.conn, event.data.sessionID)))
    })
  })

  // Shares the Home query cache so renames and deletions there refresh the inbox too.
  const queries = useQueries(() => ({
    queries: connections().map((item) => ({
      queryKey: ["home-sessions", item.conn] as const,
      enabled: item.ctx.sdk.connection.status() === "connected",
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        loadHomeSessionIndex((input, options) => item.ctx.sdk.api.session.list(input, options), signal),
      retry: false,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnReconnect: true,
      select: selectSessions,
    })),
  }))

  const archivedQueries = useQueries(() => ({
    queries: connections().map((item) => ({
      queryKey: ["inbox-archived-sessions", item.conn] as const,
      enabled: item.ctx.sdk.connection.status() === "connected",
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        item.ctx.sdk.api.session
          .list({ limit: ARCHIVED_LIMIT, order: "desc", parentID: null, archived: true }, { signal })
          .then((response) => response.data),
      retry: false,
      staleTime: 30_000,
      refetchOnMount: true,
      refetchOnReconnect: true,
      select: selectSessions,
    })),
  }))

  const entries = createMemo(() =>
    connections()
      .flatMap((item, index) => {
        const data = item.ctx.data
        const notification = item.ctx.notification.session
        const server = ServerConnection.key(item.conn)

        // A root session counts as working while any session in its family is busy.
        const busyRoots = new Set(
          [...data.session.list().map((session) => session.id), ...data.session.active()]
            .filter((id) => sessionBusy(data, id))
            .map((id) => data.session.root(id)),
        )

        const status = (session: SessionInfo): InboxStatus => {
          const project = projectSettingsKey(item.ctx.sdk.scope, session.projectID)
          const requests = sessionRequests(data, session.id, true, settings.permissions.autoApproves(project))

          if (requests.permission) return "approval"

          if (requests.form) return "input"

          if (busyRoots.has(session.id)) return "working"

          if (!notification.unread(session.id, session)) return "ready"

          return session.outcome === "failed" ? "failed" : "done"
        }

        // Locally known sessions come last so live archive and unarchive events win over cached indexes.
        const sessions = new Map(
          [
            ...(queries[index]?.data?.() ?? []),
            ...(archivedQueries[index]?.data?.() ?? []),
            ...data.session.list(),
          ].map((session) => [session.id, session] as const),
        )

        return data.session.apply([...sessions.values()].filter((session) => !session.parentID)).map(
          (session): InboxEntry => ({
            key: `${server}\0${session.id}`,
            conn: item.conn,
            server,
            ctx: item.ctx,
            session,
            status: status(session),
          }),
        )
      })
      .toSorted((a, b) => b.session.time.updated - a.session.time.updated),
  )

  const sections = createMemo(() => {
    const list = entries()

    // The most recently finished session comes first.
    const finished = list
      .filter((entry) => {
        const since = state.since

        return !busy(entry.status) && since !== undefined && (entry.session.time.idle ?? 0) >= since
      })
      .toSorted((a, b) => (b.session.time.idle ?? 0) - (a.session.time.idle ?? 0))

    return {
      needs: list.filter((entry) => entry.status === "approval" || entry.status === "input"),
      inbox: finished.filter((entry) => !archived(entry)),
      archived: finished.filter(archived),
      working: list.filter((entry) => entry.status === "working"),
    }
  })

  // The client only refreshes `time.idle` for loaded sessions when a run ends, so load every working one.
  createEffect(() => {
    sections().working.forEach((entry) => {
      if (entry.ctx.data.session.get(entry.session.id)) return
      void entry.ctx.data.session.sync(entry.session.id).catch(() => undefined)
    })
  })

  // The inbox starts empty and fills as sessions finish runs.
  createEffect(() => {
    if (ready() && state.since === undefined) setState("since", Date.now())
  })

  // Rows are keyed by stable strings so live session updates do not remount them.
  const byKey = createMemo(() => new Map(entries().map((entry) => [entry.key, entry])))

  const active = createMemo(() => {
    const route = layout.route()

    if (route.type !== "session") return

    return { server: route.server, sessionId: route.sessionId }
  })

  const selected = (entry: InboxEntry) => {
    const current = active()

    return (
      current?.server === entry.server &&
      (current.sessionId === entry.session.id || entry.ctx.data.session.root(current.sessionId) === entry.session.id)
    )
  }

  // Git info is not stored on the session, so eagerly load it for every shown row and mark each location
  // settled once its load ends.
  const [vcs, setVcs] = createStore({ settled: {} as Record<string, true> })
  const queued = new Set<string>()
  const queue: InboxEntry[] = []
  let draining = false

  const drain = async () => {
    if (draining) return
    draining = true

    while (queue.length) {
      await Promise.all(
        queue.splice(0, BRANCH_BATCH).map((entry) =>
          entry.ctx.data.location.vcs
            .sync(entry.session.location)
            .catch(() => undefined)
            .then(() => setVcs("settled", locationKey(entry), true)),
        ),
      )
    }

    draining = false
  }

  createEffect(() => {
    const visible = sections()

    ;[...visible.needs, ...visible.working, ...visible.inbox, ...visible.archived].forEach((entry) => {
      const key = locationKey(entry)

      if (queued.has(key)) return
      queued.add(key)
      queue.push(entry)
    })
    void drain()
  })

  const branchLoading = (entry: InboxEntry) =>
    !vcs.settled[locationKey(entry)] && !entry.ctx.data.location.vcs.info(entry.session.location)

  const open = (entry: InboxEntry) => {
    const directory = entry.ctx.projects.forSession(entry.session)?.worktree ?? entry.session.location.directory
    void entry.ctx.data.session.message.sync(entry.session.id).catch((error: unknown) => {
      if (isSessionNotFoundError(error)) forget(entry.conn, entry.session.id)
    })
    void startTransition(() => {
      tabs.select(tabs.addSessionTab({ server: entry.server, sessionId: entry.session.id }))
      entry.ctx.data.session.remember(entry.session)
      entry.ctx.projects.touch(directory)
    })
  }

  // Move the session between the cached indexes so it changes section before either refetches.
  const move = (entry: InboxEntry, archivedAt: number | undefined) => {
    const session = { ...entry.session, time: { ...entry.session.time, archived: archivedAt } }

    forget(entry.conn, entry.session.id)
    queryClient.setQueryData<SessionInfo[]>(
      [archivedAt === undefined ? "home-sessions" : "inbox-archived-sessions", entry.conn],
      (current) => current && [session, ...current],
    )
  }

  const requestFailed = (cause: unknown) =>
    showToast({
      title: language.t("common.requestFailed"),
      description: errorMessage(cause, language.t("common.requestFailed")),
    })

  const archive = (entry: InboxEntry) =>
    archiveHomeSession({
      server: entry.server,
      session: entry.session,
      archive: (sessionID) => entry.ctx.sdk.api.session.update({ sessionID, archived: true }),
      remove: () => move(entry, Date.now()),
      onError: requestFailed,
    })

  const unarchive = (entry: InboxEntry) =>
    entry.ctx.sdk.api.session
      .update({ sessionID: entry.session.id, archived: false })
      .then(() => move(entry, undefined))
      .catch(requestFailed)

  const remove = (entry: InboxEntry) => {
    const ids = sessionTreeIDs(entry.ctx.data.session.list(), entry.session.id)

    return entry.ctx.data.session
      .remove(entry.session.id)
      .then(() => {
        forget(entry.conn, entry.session.id)
        notifySessionTabsRemoved({ server: entry.server, directory: entry.session.location.directory, sessionIDs: ids })
      })
      .catch((cause) =>
        showToast({
          title: language.t("session.delete.failed.title"),
          description: errorMessage(cause, language.t("session.delete.failed.title")),
        }),
      )
  }

  function DeleteDialog(props: { entry: InboxEntry }) {
    const confirm = async () => {
      await remove(props.entry)
      dialog.close()
    }

    return (
      <Dialog fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("session.delete.title")}
            description={language.t("session.delete.confirm", {
              name: sessionTitle(props.entry.session.title) ?? language.t("command.session.new"),
            })}
          />
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" autofocus onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button variant="danger" onClick={confirm}>
            {language.t("session.delete.button")}
          </Button>
        </DialogFooter>
      </Dialog>
    )
  }

  // Rows in the order they appear on screen; a collapsed Working shelf still shows the open session.
  const visible = createMemo(() => {
    const list = sections()

    return [
      ...list.needs,
      ...list.inbox,
      ...list.archived,
      ...list.working.filter((entry) => state.workingExpanded || selected(entry)),
    ]
  })

  // Shortcuts follow the inbox's vertical order instead of the tab list, which this layout does not show.
  command.register("inbox-navigation", () => [
    ...visible()
      .slice(0, 9)
      .map((entry, index) => ({
        id: `tab.${index + 1}`,
        category: "tab",
        title: "",
        keybind: `mod+${index + 1}`,
        hidden: true,
        onSelect: () => open(entry),
      })),
    {
      id: "session.previous",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous"),
      keybind: "alt+arrowup",
      onSelect: () => openAdjacent(-1),
    },
    {
      id: "session.next",
      category: language.t("command.category.session"),
      title: language.t("command.session.next"),
      keybind: "alt+arrowdown",
      onSelect: () => openAdjacent(1),
    },
    {
      id: "session.previous.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.previous.unseen"),
      keybind: "shift+alt+arrowup",
      onSelect: () => openAdjacent(-1, unread),
    },
    {
      id: "session.next.unseen",
      category: language.t("command.category.session"),
      title: language.t("command.session.next.unseen"),
      keybind: "shift+alt+arrowdown",
      onSelect: () => openAdjacent(1, unread),
    },
  ])

  // Without an open inbox session, moving down starts at the top and moving up starts at the bottom.
  const openAdjacent = (offset: -1 | 1, include: (entry: InboxEntry) => boolean = () => true) => {
    const list = visible()
    const index = list.findIndex(selected)

    // Every other row in the offset's direction, wrapping around.
    const candidates =
      index === -1
        ? offset === 1
          ? list
          : list.toReversed()
        : Array.from(
            { length: list.length - 1 },
            (_, step) => list[(index + offset * (step + 1) + list.length) % list.length],
          )

    const next = candidates.find(include)

    if (next) open(next)
  }

  // Keep the open row in view when keyboard navigation selects one outside the scrolled area.
  createEffect(() => {
    if (!active()) return
    requestAnimationFrame(() =>
      root.querySelector('[data-slot="sidebar-inbox-item"][data-state="active"]')?.scrollIntoView({ block: "nearest" }),
    )
  })

  // Arrow keys move focus between rows once one is focused.
  const moveFocus = (event: KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return

    if (event.altKey || event.metaKey || event.ctrlKey || event.shiftKey) return

    const items = [...root.querySelectorAll<HTMLElement>('[data-slot="sidebar-inbox-item"]')]
    const index = items.findIndex((item) => item === event.target)

    if (index === -1) return
    event.preventDefault()
    items[Math.min(items.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))]?.focus()
  }

  const rows = (list: InboxEntry[]) => (
    <For each={list.map((entry) => entry.key)}>
      {(key) => (
        <Show when={byKey().get(key)}>
          {(entry) => (
            <InboxRow
              entry={entry()}
              selected={selected(entry())}
              now={now()}
              branchLoading={branchLoading(entry())}
              archived={archived(entry())}
              onOpen={() => open(entry())}
              onArchive={() => void archive(entry())}
              onUnarchive={() => void unarchive(entry())}
              onDelete={() => dialog.show(() => <DeleteDialog entry={entry()} />)}
            />
          )}
        </Show>
      )}
    </For>
  )

  return (
    <div ref={root} data-slot="sidebar-inbox" class="flex min-h-0 flex-1 flex-col" onKeyDown={moveFocus}>
      <div data-slot="sidebar-inbox-scroll" class="flex min-h-0 flex-1 flex-col gap-px overflow-y-auto pb-1">
        <Show when={sections().needs.length > 0}>
          <div class="flex shrink-0 flex-col gap-px pb-3">
            <SectionHeader label={language.t("sidebar.inbox.section.needsAttention")} count={sections().needs.length} />
            {rows(sections().needs)}
          </div>
        </Show>
        <Show
          when={sections().inbox.length > 0}
          fallback={
            <Show
              when={
                sections().needs.length === 0 && sections().working.length === 0 && sections().archived.length === 0
              }
            >
              <div class="px-1.5 py-2 text-[13px] leading-4 text-v2-text-text-faint">
                {language.t("sidebar.inbox.empty")}
              </div>
            </Show>
          }
        >
          <Show when={sections().needs.length > 0}>
            <SectionHeader label={language.t("sidebar.inbox.section.recent")} />
          </Show>
          {rows(sections().inbox)}
        </Show>
        <Show when={sections().archived.length > 0}>
          <div class="flex shrink-0 flex-col gap-px pt-3">
            <SectionHeader label={language.t("sidebar.inbox.section.archived")} />
            {rows(sections().archived)}
          </div>
        </Show>
      </div>
      {/* Working sessions sit in a shelf pinned below the scrolling list. */}
      <Show when={sections().working.length > 0}>
        <div
          data-slot="sidebar-inbox-working"
          class="flex max-h-[40%] shrink-0 flex-col gap-px border-t border-v2-border-border-muted pt-1.5"
        >
          <SectionHeader
            label={language.t("sidebar.inbox.section.working")}
            count={sections().working.length}
            expanded={state.workingExpanded}
            onToggle={() => setState("workingExpanded", !state.workingExpanded)}
          />
          <div class="flex min-h-0 flex-col gap-px overflow-y-auto">
            {/* A collapsed shelf still shows the session that is open. */}
            {rows(sections().working.filter((entry) => state.workingExpanded || selected(entry)))}
          </div>
        </div>
      </Show>
    </div>
  )
}

function SectionHeader(props: { label: string; count?: number; expanded?: boolean; onToggle?: () => void }) {
  const content = (): JSX.Element => (
    <>
      <span class="min-w-0 truncate">{props.label}</span>
      <Show when={props.count}>
        <span class="shrink-0 tabular-nums text-v2-text-text-faint">{props.count}</span>
      </Show>
      <Show when={props.onToggle}>
        <Icon
          name="chevron-down"
          size="small"
          class="ms-auto shrink-0 transition-transform"
          classList={{ "-rotate-90 rtl:rotate-90": !props.expanded }}
        />
      </Show>
    </>
  )

  return (
    <Show
      when={props.onToggle}
      fallback={
        <div class="flex h-6 shrink-0 items-center gap-1.5 px-1.5 text-[12px] leading-4 font-medium text-v2-text-text-muted">
          {content()}
        </div>
      }
    >
      {(toggle) => (
        <button
          type="button"
          aria-expanded={props.expanded}
          class="flex h-6 w-full shrink-0 items-center gap-1.5 rounded-[6px] px-1.5 text-start text-[12px] leading-4 font-medium text-v2-text-text-muted hover:text-v2-text-text-base focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
          onClick={toggle()}
        >
          {content()}
        </button>
      )}
    </Show>
  )
}

function InboxRow(props: {
  entry: InboxEntry
  selected: boolean
  now: number
  branchLoading: boolean
  archived: boolean
  onOpen: () => void
  onArchive: () => void
  onUnarchive: () => void
  onDelete: () => void
}) {
  const language = useLanguage()
  const project = createMemo(() => props.entry.ctx.projects.forSession(props.entry.session))
  const status = () => props.entry.status

  const worktree = () => inWorktree(props.entry)

  const branch = () => props.entry.ctx.data.location.vcs.info(props.entry.session.location)?.branch.current ?? undefined

  // Only sessions on a remote server are marked.
  const remote = () => !props.entry.ctx.isLocal

  const compact = (seconds: number) => {
    if (seconds < 3600) return language.plural("sidebar.inbox.elapsed.minutes", Math.floor(seconds / 60))

    if (seconds < 86_400) return language.plural("sidebar.inbox.elapsed.hours", Math.floor(seconds / 3600))

    return language.plural("sidebar.inbox.elapsed.days", Math.floor(seconds / 86_400))
  }

  const elapsed = () => {
    // `time.updated` moves when a prompt is enqueued, so it marks when the current run was requested.
    const seconds = Math.max(0, Math.floor((props.now - props.entry.session.time.updated) / 1000))

    return seconds < 60 ? language.plural("sidebar.inbox.elapsed.seconds", seconds) : compact(seconds)
  }

  const age = () => {
    const seconds = Math.max(
      0,
      Math.floor((props.now - (props.entry.session.time.idle ?? props.entry.session.time.updated)) / 1000),
    )

    return seconds < 60 ? language.t("sidebar.inbox.time.now") : compact(seconds)
  }

  return (
    <Menu.Context modal={false}>
      <Menu.Context.Trigger
        as="button"
        type="button"
        data-slot="sidebar-inbox-item"
        data-status={status()}
        data-state={props.selected ? "active" : undefined}
        class="group flex w-full shrink-0 flex-col gap-0.5 rounded-[6px] px-1.5 py-1.5 text-start hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover data-[state=active]:bg-v2-background-bg-layer-02"
        classList={{
          "transition-opacity hover:opacity-100 focus-visible:opacity-100": !props.selected,
          "opacity-70": status() === "working" && !props.selected,
          "opacity-50": props.archived && !props.selected,
        }}
        onClick={props.onOpen}
      >
        <span class="flex h-4 w-full min-w-0 items-center gap-1.5 text-[12px] leading-4 text-v2-text-text-faint">
          <span class="flex size-4 shrink-0 items-center justify-center">
            <SessionTabAvatarView
              project={project()}
              directory={props.entry.session.location.directory}
              unread={false}
            />
          </span>
          <span class="min-w-0 truncate">
            {displayName(project() ?? { worktree: props.entry.session.location.directory })}
          </span>
          <span class="ms-auto shrink-0 tabular-nums" role={status() === "ready" ? undefined : "status"}>
            <Show when={status() !== "ready"} fallback={age()}>
              <span
                classList={{
                  "text-v2-state-fg-warning": status() === "approval" || status() === "input",
                  "text-v2-state-fg-info": status() === "working",
                  "text-v2-state-fg-danger": status() === "failed",
                  "text-v2-state-fg-success": status() === "done",
                }}
              >
                <Show
                  when={status() === "working"}
                  fallback={language.t(`sidebar.inbox.status.${status() as Exclude<InboxStatus, "ready">}`)}
                >
                  {/* Announce only the status: the ticking duration would be re-read every second. */}
                  <span class="sr-only">{language.t("sidebar.inbox.status.working")}</span>
                  {/* Keep the status colour under the sweep. */}
                  <span
                    aria-hidden="true"
                    class="[&_[data-component=text-shimmer]]:[--text-shimmer-base-color:var(--v2-state-fg-info)]"
                  >
                    <TextShimmer text={language.t("sidebar.inbox.status.workingFor", { duration: elapsed() })} active />
                  </span>
                </Show>
              </span>
            </Show>
          </span>
        </span>
        <span
          dir="auto"
          class="w-full min-w-0 truncate text-[13px] leading-4"
          // Rows recede once read so unread results stand out.
          classList={{
            "font-medium text-v2-text-text-base": unread(props.entry),
            "text-v2-text-text-muted": !unread(props.entry),
          }}
        >
          {sessionTabTitle(props.entry.session.title, language.t("session.tab.session"))}
        </span>
        <Show when={props.branchLoading || branch() || worktree() || remote()}>
          <span class="flex h-4 w-full min-w-0 items-center gap-1 text-[12px] leading-4 text-v2-text-text-faint">
            <Show when={props.branchLoading}>
              <span
                aria-hidden="true"
                class="h-2.5 w-24 max-w-full animate-pulse rounded-full bg-v2-background-bg-layer-03"
              />
            </Show>
            <Show when={!props.branchLoading && (branch() || worktree())}>
              <span class="flex min-w-0 items-center gap-1">
                {/* The worktree icon stands in for the branch icon to mark sessions outside the project checkout. */}
                <Icon name={worktree() ? "outline-worktree" : "branch"} size="small" class="shrink-0" />
                <Show when={branch()}>
                  {(name) => (
                    <span dir="ltr" class="min-w-0 truncate">
                      {name()}
                    </span>
                  )}
                </Show>
              </span>
            </Show>
            <Show when={remote()}>
              <Tooltip placement="right" value={serverName(props.entry.conn)} class="ms-auto flex shrink-0">
                <Icon name="server" size="small" aria-label={serverName(props.entry.conn)} />
              </Tooltip>
            </Show>
          </span>
        </Show>
      </Menu.Context.Trigger>
      <Menu.Context.Portal>
        <Menu.Context.Content>
          <Show
            when={props.archived}
            fallback={<Menu.Item onSelect={props.onArchive}>{language.t("common.archive")}</Menu.Item>}
          >
            <Menu.Item onSelect={props.onUnarchive}>{language.t("sidebar.inbox.unarchive")}</Menu.Item>
          </Show>
          <Menu.Separator />
          <Menu.Item onSelect={props.onDelete}>{language.t("common.delete")}…</Menu.Item>
        </Menu.Context.Content>
      </Menu.Context.Portal>
    </Menu.Context>
  )
}

function unread(entry: InboxEntry) {
  return entry.status !== "ready" && entry.status !== "working"
}

function archived(entry: InboxEntry) {
  return entry.session.time.archived !== undefined
}

function busy(status: InboxStatus) {
  return status === "working" || status === "approval" || status === "input"
}

function locationKey(entry: InboxEntry) {
  return `${entry.server}\0${pathKey(entry.session.location.directory)}`
}

function inWorktree(entry: InboxEntry) {
  const root = entry.ctx.projects.forSession(entry.session)?.worktree

  return !!root && pathKey(root) !== pathKey(entry.session.location.directory)
}
