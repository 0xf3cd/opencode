import type { ModelRef } from "@opencode/client/promise"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { enter, frameLoop, observeReducedMotion, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/runtime/i18n/language"
import { AgentGlyph, type AgentActivity } from "@/session/agent-glyph/agent-glyph"
import {
  activeState,
  agentProgressCounts,
  formatElapsed,
  type AgentProgressItem,
  type AgentProgressState,
} from "./agent-progress"
import "./agent-progress-chip.css"

// Live-tunable motion (the story and the motion panel set it). Springs are SwiftUI duration and bounce, as on iOS.
export const agentChipTuning = {
  // The chip and the panel, one surface morphing both ways.
  morph: { duration: 0.34, bounce: 0.12 },
  // The chip following its words as the counts change: glass, words and glyph on one unbouncy spring.
  resize: { duration: 0.4, bounce: 0 },
  // Slows every chip spring for review (1 is real time).
  timeScale: 1,
}

const CHIP_HEIGHT = 28

const RADIUS_CLOSED = CHIP_HEIGHT / 2

const RADIUS_OPEN = 10

type AgentProgressProps = {
  items: readonly AgentProgressItem[]
  modelName?: (model: ModelRef) => string | undefined
  onOpen: (item: AgentProgressItem) => void
  onStop: (item: AgentProgressItem) => void
  // Exposed for the story and the motion panel.
  open?: boolean
  onOpenChange?: (open: boolean) => void
  now?: () => number
}

// Subagent work above the composer: a chip with the batch's progress that morphs into a panel of its rows, the chip
// staying as the panel's bottom row. Ported from the iOS app's background-work capsule and panel.
export function AgentProgressChip(props: AgentProgressProps) {
  // The last batch stays drawn while the chip fades out.
  const [mounted, setMounted] = createSignal(props.items.length > 0)
  const [held, setHeld] = createSignal(props.items, { equals: false })
  let surface: HTMLElement | undefined
  let fade: Animation | undefined

  createEffect(
    on(
      () => [props.items, props.items.length] as const,
      ([items, length]) => {
        if (length) {
          // Work arriving mid-fade takes the chip back.
          fade?.cancel()
          fade = undefined
          setHeld(items)
          setMounted(true)

          return
        }

        if (!surface || prefersReducedMotion()) return setMounted(false)
        props.onOpenChange?.(false)
        fade = surface.animate([{ opacity: 1 }, { opacity: 0, translate: "0 4px" }], {
          duration: 160,
          easing: "ease-in",
          fill: "forwards",
        })
        fade.finished.then(
          () => setMounted(false),
          () => undefined,
        )
      },
      { defer: true },
    ),
  )

  return (
    <Show when={mounted()}>
      <AgentProgressBody
        {...props}
        items={held()}
        surface={(element) => {
          surface = element
        }}
      />
    </Show>
  )
}

function AgentProgressBody(props: AgentProgressProps & { surface: (element: HTMLElement) => void }) {
  const language = useLanguage()
  const [local, setLocal] = createStore({ open: false, doneExpanded: false })
  const open = () => props.open ?? local.open

  const setOpen = (next: boolean) => {
    setLocal("open", next)
    props.onOpenChange?.(next)
  }

  const [refs, setRefs] = createStore<{
    root?: HTMLDivElement
    surface?: HTMLDivElement
    panel?: HTMLDivElement
    chip?: HTMLButtonElement
    content?: HTMLSpanElement
  }>({})

  const counts = createMemo(() => agentProgressCounts(props.items))
  const group = (states: AgentProgressState[]) => props.items.filter((item) => states.includes(item.state))
  const needsYou = createMemo(() => group(["needs-you"]))
  const running = createMemo(() => group(["running", "starting"]))
  const failed = createMemo(() => group(["failed"]))
  const done = createMemo(() => group(["done", "stopped"]))
  const single = () => (props.items.length === 1 ? props.items[0] : undefined)

  // Elapsed times tick only while someone can see one move.
  const [tick, setTick] = createSignal(Date.now())
  const now = () => props.now?.() ?? tick()
  createEffect(() => {
    if (props.now) return

    if (!(open() || single()) || !props.items.some((item) => activeState(item.state))) return
    setTick(Date.now())
    const timer = setInterval(() => setTick(Date.now()), 1000)
    onCleanup(() => clearInterval(timer))
  })

  const elapsed = (item: AgentProgressItem) =>
    item.started === undefined ? undefined : formatElapsed((item.ended ?? now()) - item.started)

  const singleStatus = (item: AgentProgressItem) => {
    const key = stateLabel[item.state]

    return key ? language.t(key) : (elapsed(item) ?? "")
  }

  // The most telling state, for the chip's glyph. Unlike iOS, running outranks a failure while work continues.
  const summary = createMemo<AgentActivity>(() => {
    const value = counts()

    if (value.needsYou) return "waiting"

    if (running().length && running().every((item) => item.state === "starting")) return "handoff"

    if (value.running) return "thinking"

    if (value.failed) return "failed"

    return "done"
  })

  const label = createMemo(() => {
    const value = counts()

    if (value.running && !value.done) return language.t("session.agents.running", { count: value.running })

    if (!value.running && !value.needsYou && !value.failed)
      return language.t("session.agents.allDone", { count: value.total })

    return language.t("session.agents.progress", { done: value.done, total: value.total })
  })

  // The chip's words as one phrase, for its accessible name.
  const summaryText = createMemo(() =>
    [
      single() ? `${single()!.title} ${singleStatus(single()!)}` : label(),
      counts().failed && !single() ? language.t("session.agents.failed", { count: counts().failed }) : undefined,
      counts().needsYou ? language.plural("session.agents.needsYou", counts().needsYou) : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  )

  const header = createMemo(() =>
    [
      counts().running ? language.t("session.agents.running", { count: counts().running }) : undefined,
      counts().done ? language.t("session.agents.done", { count: counts().done }) : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
  )

  const stoppable = (item: AgentProgressItem) => item.type === "shell" || !!item.sessionID

  // Rows are keyed by the work they show, not by item objects, which the data layer rebuilds on every update: a row
  // and its glyph live on as its state changes.
  const byKey = createMemo(() => new Map(props.items.map((item) => [item.key, item])))

  const keys = (items: () => AgentProgressItem[]) =>
    createMemo(() => items().map((item) => item.key), [], {
      equals: (a, b) => a.length === b.length && a.every((key, index) => key === b[index]),
    })

  const activeKeys = keys(() => [...needsYou(), ...running(), ...failed()])
  const doneKeys = keys(done)

  const KeyedRow = (row: { key: string }) => (
    <Show when={byKey().get(row.key)}>
      {(item) => (
        <Row
          item={item()}
          model={item().model ? props.modelName?.(item().model!) : undefined}
          elapsed={elapsed(item())}
          paused={!open()}
          stoppable={stoppable(item())}
          onOpen={() => openItem(item())}
          onStop={() => props.onStop(item())}
        />
      )}
    </Show>
  )

  const stopAll = () =>
    props.items.filter((item) => activeState(item.state) && stoppable(item)).forEach((item) => props.onStop(item))

  const openItem = (item: AgentProgressItem) => {
    setOpen(false)
    props.onOpen(item)
  }

  // Closing from inside the panel returns focus to the chip, its own bottom row.
  const close = () => {
    const inside = !!refs.surface?.contains(document.activeElement)
    setOpen(false)

    if (inside) refs.chip?.focus()
  }

  createEffect(() => {
    if (!open()) return
    makeEventListener(document, "pointerdown", (event) => {
      if (refs.surface && !event.composedPath().includes(refs.surface)) setOpen(false)
    })
    makeEventListener(document, "keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      close()
    })
  })

  onMount(() => {
    if (refs.surface) enter(refs.surface, { y: 4, duration: 180 })
  })

  createSurfaceMotion({
    refs,
    open,
    watch: () => {
      label()
      void props.items.length
      void local.doneExpanded
      void single()?.state
    },
  })

  // Words changing: the old fade and blur out as the new ones come in, like the iOS capsule's counts.
  createEffect(
    on(
      () => [label(), counts().failed, counts().needsYou] as const,
      () => {
        if (refs.content && !prefersReducedMotion()) {
          refs.content.animate(
            [
              { opacity: 0.35, filter: "blur(2px)" },
              { opacity: 1, filter: "blur(0)" },
            ],
            { duration: 220, easing: "cubic-bezier(.22, 1, .36, 1)" },
          )
        }
      },
      { defer: true },
    ),
  )

  return (
    <div
      ref={(element) => setRefs("root", element)}
      data-component="agent-progress"
      data-open={open() ? "" : undefined}
    >
      <div
        ref={(element) => {
          setRefs("surface", element)
          props.surface(element)
        }}
        data-slot="agent-progress-surface"
        data-needs-you={counts().needsYou ? "" : undefined}
      >
        <div
          ref={(element) => setRefs("panel", element)}
          id="agent-progress-panel"
          data-slot="agent-progress-panel"
          role="group"
          aria-label={language.t("session.agents.panel")}
          inert={!open()}
        >
          <div data-slot="agent-progress-header">
            <span class="min-w-0 flex-1 truncate">{header()}</span>
            <Show when={running().some(stoppable) || needsYou().some(stoppable)}>
              <button type="button" data-slot="agent-progress-stop-all" onClick={stopAll}>
                {language.t("session.agents.stopAll")}
              </button>
            </Show>
          </div>
          <div data-slot="agent-progress-rows">
            <For each={activeKeys()}>{(key) => <KeyedRow key={key} />}</For>
            <Show when={doneKeys().length}>
              <button
                type="button"
                data-slot="agent-progress-done-toggle"
                aria-expanded={local.doneExpanded}
                onClick={() => setLocal("doneExpanded", (value) => !value)}
              >
                <Icon name="check-small" class="shrink-0 text-v2-icon-icon-muted" />
                <span>{language.t("session.agents.done", { count: doneKeys().length })}</span>
                <Icon name="chevron-right" data-slot="agent-progress-chevron" />
              </button>
              <Show when={local.doneExpanded}>
                <For each={doneKeys()}>{(key) => <KeyedRow key={key} />}</For>
              </Show>
            </Show>
          </div>
        </div>
        <button
          ref={(element) => setRefs("chip", element)}
          type="button"
          data-slot="agent-progress-chip"
          aria-expanded={open()}
          aria-controls="agent-progress-panel"
          aria-label={summaryText()}
          onClick={() => setOpen(!open())}
        >
          <span ref={(element) => setRefs("content", element)} data-slot="agent-progress-chip-content">
            <AgentGlyph activity={single() ? glyph[single()!.state] : summary()} size={16} />
            <Show
              when={single()}
              fallback={
                <>
                  <span>{label()}</span>
                  <Show when={counts().failed}>
                    <span data-slot="agent-progress-failed">
                      · {language.t("session.agents.failed", { count: counts().failed })}
                    </span>
                  </Show>
                </>
              }
            >
              {(item) => (
                <>
                  <span dir="auto" class="truncate">
                    {item().title}
                  </span>
                  <span data-slot="agent-progress-elapsed">{singleStatus(item())}</span>
                </>
              )}
            </Show>
            <Show when={counts().needsYou}>
              <span data-slot="agent-progress-needs-you">
                · {language.plural("session.agents.needsYou", counts().needsYou)}
              </span>
            </Show>
          </span>
        </button>
      </div>
    </div>
  )
}

function Row(props: {
  item: AgentProgressItem
  model?: string
  elapsed?: string
  paused: boolean
  stoppable: boolean
  onOpen: () => void
  onStop: () => void
}) {
  const language = useLanguage()

  const meta = () =>
    [
      props.item.type === "shell"
        ? language.t("ui.tool.shell")
        : props.item.agent
          ? `${props.item.agent[0]!.toUpperCase()}${props.item.agent.slice(1)}`
          : language.t("ui.tool.agent.default"),
      props.model,
    ]
      .filter(Boolean)
      .join(" · ")

  const state = () => props.item.state
  // A row that only just finished shows its arrival: the glyph starts from running and flashes into place.
  const from = props.item.ended !== undefined && Date.now() - props.item.ended < 1500 ? "thinking" : undefined

  return (
    <div data-slot="agent-progress-row" data-state={state()}>
      <button type="button" data-slot="agent-progress-row-open" onClick={props.onOpen}>
        <Show
          when={props.item.type === "subagent"}
          fallback={<Icon name="console" class="shrink-0 text-v2-icon-icon-muted" />}
        >
          <AgentGlyph activity={glyph[state()]} from={from} size={16} paused={props.paused} />
        </Show>
        <span dir="auto" data-slot="agent-progress-title">
          {props.item.title}
        </span>
        <span data-slot="agent-progress-meta">{meta()}</span>
      </button>
      <span data-slot="agent-progress-trailing">
        <Switch
          fallback={
            <>
              <span data-slot="agent-progress-elapsed">
                {state() === "starting" ? language.t("session.agents.state.starting") : props.elapsed}
              </span>
              <Show when={props.stoppable}>
                <IconButton
                  type="button"
                  size="small"
                  variant="ghost-muted"
                  icon={<Icon name="outline-xmark" />}
                  aria-label={language.t(
                    props.item.type === "shell" ? "session.running.stop.shell" : "session.running.stop.subagent",
                  )}
                  onClick={props.onStop}
                />
              </Show>
            </>
          }
        >
          <Match when={state() === "needs-you"}>
            <button type="button" data-slot="agent-progress-review" onClick={props.onOpen}>
              {language.t("session.agents.review")}
            </button>
          </Match>
          <Match when={state() === "failed"}>
            <span data-slot="agent-progress-error" title={props.item.error}>
              {props.item.error ?? language.t("session.agents.state.failed")}
            </span>
          </Match>
          <Match when={state() === "done" || state() === "stopped"}>
            <span data-slot="agent-progress-elapsed">
              {state() === "stopped" ? language.t("session.agents.state.stopped") : props.elapsed}
            </span>
          </Match>
        </Switch>
      </span>
    </div>
  )
}

// Each row's glyph design: the iOS subagent states, without its live event ledger (so no tool or output bursts).
const glyph: Record<AgentProgressState, AgentActivity> = {
  "needs-you": "waiting",
  starting: "handoff",
  running: "thinking",
  failed: "failed",
  done: "done",
  stopped: "idle",
}

// Finished states name themselves; running ones show their elapsed time instead.
const stateLabel: Partial<
  Record<
    AgentProgressState,
    | "session.agents.state.failed"
    | "session.agents.state.done"
    | "session.agents.state.stopped"
    | "session.agents.state.starting"
  >
> = {
  failed: "session.agents.state.failed",
  done: "session.agents.state.done",
  stopped: "session.agents.state.stopped",
  starting: "session.agents.state.starting",
}

// One surface, two sizes: the chip's own width, or the panel's measured box. Toggling morphs on `morph`; content
// changes within a state follow on `resize`. Everything is laid out at its final size first and only the surface's
// clip moves, so the panel's height is known before it opens.
function createSurfaceMotion(input: {
  refs: { root?: HTMLElement; surface?: HTMLElement; panel?: HTMLElement; content?: HTMLElement }
  open: () => boolean
  watch: () => void
}) {
  const width = new Spring(0)
  const height = new Spring(CHIP_HEIGHT)
  const progress = new Spring(0)
  const springs = [width, height, progress]
  let first = true
  let wasOpen = input.open()
  let reduced = prefersReducedMotion()
  let remove: (() => void) | undefined

  const tune = (curve: { duration: number; bounce: number }) => {
    const omega = (2 * Math.PI) / curve.duration
    springs.forEach((spring) => {
      spring.omega = omega
      spring.zeta = 1 - curve.bounce
    })
  }

  const read = () => {
    const { root, panel, content } = input.refs

    if (!root || !panel || !content) return
    const open = input.open()

    if (open !== wasOpen) tune(agentChipTuning.morph)

    if (open === wasOpen && width.resting && height.resting) tune(agentChipTuning.resize)
    wasOpen = open
    const room = root.offsetWidth
    width.set(open ? panel.offsetWidth : Math.min(content.offsetWidth, room))
    height.set(open ? panel.offsetHeight + CHIP_HEIGHT : CHIP_HEIGHT)
    progress.set(open ? 1 : 0)
  }

  const write = (frame: number) => {
    const surface = input.refs.surface

    if (!surface) {
      remove = undefined

      return false
    }

    const dt = frame * agentChipTuning.timeScale
    springs.forEach((spring) => (first || reduced ? spring.snap(spring.target) : spring.step(dt)))
    first = false
    const p = Math.min(1, Math.max(0, progress.value))
    surface.style.width = `${width.value}px`
    surface.style.height = `${Math.max(CHIP_HEIGHT, height.value)}px`
    surface.style.borderRadius = `${RADIUS_CLOSED + (RADIUS_OPEN - RADIUS_CLOSED) * p}px`
    surface.style.setProperty("--agent-progress-open", String(p))
    const moving = springs.some((spring) => !spring.resting)

    if (!moving) remove = undefined

    return moving
  }

  const wake = () => {
    if (!remove) remove = frameLoop.addMeasured(read, write)
  }

  tune(agentChipTuning.resize)
  createEffect(() => {
    input.open()
    input.watch()
    wake()
  })
  createEffect(() => {
    const { root, panel, content } = input.refs

    if (!root || !panel || !content || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(wake)
    observer.observe(root)
    observer.observe(panel)
    observer.observe(content)
    onCleanup(() => observer.disconnect())
  })
  onCleanup(
    observeReducedMotion(() => {
      reduced = prefersReducedMotion()
      wake()
    }),
  )
  onCleanup(() => remove?.())
}
