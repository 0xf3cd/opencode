import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Menu } from "@opencode/ui/menu"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import { createAnimatedPresence } from "@/runtime/animated-presence"
import "./activity-chips.css"

export type SessionActivityItem = {
  key: string
  type: "subagent" | "shell"
  label?: string
  agent?: string
  sessionID?: string
  target: string
}

// Live work above the composer, one capsule like the iOS app's background-work summary. It floats out of flow in a
// lane the timeline reserves at its tail, so coming and going never resizes the composer region or moves the timeline.
export function SessionActivityChips(props: {
  subagents: readonly SessionActivityItem[]
  shells: readonly SessionActivityItem[]
  onOpen: (item: SessionActivityItem) => void
  onStop: (item: SessionActivityItem) => void
}) {
  const language = useLanguage()

  // With one kind running, the capsule row already names it.
  const both = () => props.subagents.length > 0 && props.shells.length > 0

  // A subagent can only be interrupted once its child session exists.
  const stoppable = (item: SessionActivityItem) => item.type === "shell" || !!item.sessionID

  const row = (item: SessionActivityItem) => ({
    "data-stoppable": stoppable(item) || undefined,
    onSelect: () => props.onOpen(item),
    onKeyDown: (event: KeyboardEvent) => {
      if ((event.key !== "Delete" && event.key !== "Backspace") || !stoppable(item)) return

      event.preventDefault()
      props.onStop(item)
    },
  })

  const stop = (item: SessionActivityItem) => (
    <Show when={stoppable(item)}>
      {/* The row selects on press, so the stop button keeps its pointer events to itself. */}
      <IconButton
        type="button"
        size="small"
        variant="ghost-muted"
        tabIndex={-1}
        data-slot="session-activity-stop"
        icon={<Icon name="outline-xmark" />}
        aria-label={language.t(item.type === "shell" ? "session.running.stop.shell" : "session.running.stop.subagent")}
        onPointerDown={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
        onPointerUp={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation()
          props.onStop(item)
        }}
      />
    </Show>
  )

  const active = () => props.subagents.length > 0 || props.shells.length > 0

  // The capsule keeps naming the last work while it leaves.
  const label = createMemo<string>(
    (previous) =>
      active() ? language.activitySummary({ subagents: props.subagents.length, shells: props.shells.length }) : previous,
    "",
  )

  // Each session mounts its own composer, so a capsule that is already there on a switch stays at rest; only work
  // that starts while the session is open fades in.
  const [enter, setEnter] = createSignal(!active())
  createEffect(() => {
    if (!active()) setEnter(true)
  })

  // Leaving, it fades out before it unmounts.
  const [chip, setChip] = createSignal<HTMLElement>()

  const presence = createAnimatedPresence(
    () => (active() ? true : undefined),
    () => chip() ?? null,
  )

  return (
    <Show when={presence.present()}>
      <div
        data-component="session-activity-chips"
        class="pointer-events-none absolute inset-x-0 bottom-full flex items-center pb-2"
      >
        <Menu gutter={6} placement="top-start">
          <Menu.Trigger
            as="button"
            type="button"
            ref={setChip}
            data-slot="session-activity-chip"
            class="pointer-events-auto flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full border border-v2-border-border-base bg-v2-background-bg-base ps-2 pe-2.5 text-[13px] font-[530] leading-text-compact tracking-[-0.04px] whitespace-nowrap tabular-nums text-v2-text-text-base shadow-[var(--v2-elevation-raised)] outline-none duration-150 ease-out motion-reduce:animate-none hover:bg-v2-background-bg-layer-01 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-v2-border-border-focus"
            classList={{
              "animate-in fade-in": enter() && active(),
              "animate-out fade-out fill-mode-forwards duration-[110ms] ease-[cubic-bezier(.4,0,1,1)]": !active(),
            }}
          >
            <SessionProgressIndicatorV2 class="shrink-0" />
            <span class="truncate">{label()}</span>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content data-slot="session-activity-panel" aria-label={label()}>
              <Show when={props.subagents.length > 0}>
                <Menu.Group>
                  <Show when={both()}>
                    <Menu.GroupLabel>{language.t("session.activity.section.subagents")}</Menu.GroupLabel>
                  </Show>
                  <For each={props.subagents}>
                    {(item) => (
                      <Menu.Item {...row(item)}>
                        <SessionProgressIndicatorV2 class="shrink-0 text-v2-icon-icon-muted" />
                        <span class="shrink-0 font-[530]">
                          {item.agent
                            ? `${item.agent[0].toUpperCase()}${item.agent.slice(1)}`
                            : language.t("ui.tool.agent.default")}
                        </span>
                        <span
                          dir="auto"
                          class="min-w-0 flex-1 truncate text-v2-text-text-muted"
                          classList={{ "me-1.5": !stoppable(item) }}
                        >
                          {item.label}
                        </span>
                        {stop(item)}
                      </Menu.Item>
                    )}
                  </For>
                </Menu.Group>
              </Show>
              <Show when={both()}>
                <Menu.Separator />
              </Show>
              <Show when={props.shells.length > 0}>
                <Menu.Group>
                  <Show when={both()}>
                    <Menu.GroupLabel>{language.t("session.activity.section.shells")}</Menu.GroupLabel>
                  </Show>
                  <For each={props.shells}>
                    {(item) => (
                      <Menu.Item {...row(item)}>
                        <Icon name="console" class="shrink-0 text-v2-icon-icon-muted" />
                        <span dir="ltr" class="min-w-0 flex-1 truncate font-mono text-[13px] tracking-[-0.04px] text-v2-text-text-base">
                          {item.label}
                        </span>
                        {stop(item)}
                      </Menu.Item>
                    )}
                  </For>
                </Menu.Group>
              </Show>
            </Menu.Content>
          </Menu.Portal>
        </Menu>
      </div>
    </Show>
  )
}
