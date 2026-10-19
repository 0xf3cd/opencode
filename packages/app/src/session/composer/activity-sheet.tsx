import { AnimatedNumber } from "@opencode/ui/animated-number"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { SessionProgressIndicatorV2 } from "@opencode/session-ui/v2/session-progress-indicator-v2"
import { makeEventListener } from "@solid-primitives/event-listener"
import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show, untrack, type JSX } from "solid-js"
import { useLanguage } from "@/runtime/i18n/language"
import type { SessionActivityItem } from "./activity-chips"
import "./activity-sheet.css"

export type SessionActivitySubagent = SessionActivityItem & { started?: number }

const group = "Composer sheet"

/** One spring for the whole sheet: the band growing out of the composer, the list sheeting up, and rows. */
export const composerSheetSpring = motionTuning.spring("composerSheet", {
  label: "Spring",
  group,
  duration: 0.45,
  bounce: 0,
})

const presets = [
  ["Snappy", 0.25, 0.15],
  ["Smooth", 0.45, 0],
  ["Calm", 0.4, 0],
] as const

presets.forEach(([label, duration, bounce]) =>
  motionTuning.action({
    id: `composerSheet.preset.${label.toLowerCase()}`,
    label: `${label} ${duration} / ${bounce}`,
    group,
    run: () => {
      const knob = motionTuning.list().find((item) => item.id === "composerSheet")

      if (knob?.kind === "spring") motionTuning.set(knob, { duration, bounce })
    },
  }),
)

// Band row and list row heights, the list's top inset, and the tallest the list grows before it scrolls.
const BAND = 36
const ROW = 32
const INSET = 4
const MAX = INSET + ROW * 7
// A finished row shows its check this long before it leaves an open sheet.
const HOLD = 700

type Row = {
  key: string
  item: () => SessionActivitySubagent
  setItem: (item: SessionActivitySubagent) => void
  done: () => boolean
  setDone: (done: boolean) => void
  spring: Spring
  hold?: ReturnType<typeof setTimeout>
  slot?: HTMLDivElement
  body?: HTMLDivElement
}

/**
 * Running subagents as a band on the composer's own surface. The band grows out of the composer's top edge while
 * work runs; opening it sheets the list up over the timeline from the band without changing the region's height.
 */
export function SessionActivitySheet(props: {
  subagents: readonly SessionActivitySubagent[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onOpen: (item: SessionActivitySubagent) => void
  onStop?: (item: SessionActivitySubagent) => void
  children: JSX.Element
}) {
  const language = useLanguage()
  // The first paint is the resting state: rows already running when the sheet mounts start in place.
  const [rows, setRows] = createSignal<Row[]>(untrack(() => props.subagents.map((item) => create(item, 100))))
  const [now, setNow] = createSignal(Date.now())
  const band = new Spring(rows().length > 0 ? 100 : 0)
  const expand = new Spring(rows().length > 0 && untrack(() => props.open) ? 100 : 0)
  let root: HTMLDivElement | undefined
  let spacer: HTMLDivElement | undefined
  let surface: HTMLDivElement | undefined
  let clip: HTMLDivElement | undefined
  let list: HTMLDivElement | undefined
  let header: HTMLDivElement | undefined
  let chevron: HTMLSpanElement | undefined
  let hairline: HTMLDivElement | undefined
  let stop: (() => void) | undefined

  const live = createMemo(() => rows().filter((row) => !row.done()))
  // While the last row leaves, the band keeps reading what it last showed instead of "0".
  const count = createMemo<number>((previous) => live().length || previous, 0)
  // The localized summary around its count, so the count can roll on its own.
  const summary = createMemo(() => {
    const text = language.activitySummary({ subagents: count(), shells: 0 })
    const at = text.indexOf(String(count()))

    return at < 0 ? ["", text] : [text.slice(0, at), text.slice(at + String(count()).length)]
  })
  const elapsed = createMemo<number>((previous) => {
    const starts = live().flatMap((row) => row.item().started ?? [])

    if (starts.length === 0) return previous

    return Math.max(0, Math.floor((now() - Math.min(...starts)) / 1000))
  }, 0)

  const tick = setInterval(() => setNow(Date.now()), 1000)
  onCleanup(() => clearInterval(tick))

  const tune = (spring: Spring) => {
    const value = composerSheetSpring()
    spring.omega = (2 * Math.PI) / value.duration
    spring.zeta = 1 - value.bounce
  }

  const retarget = () => {
    const present = rows().some((row) => row.spring.target > 0)

    tune(band)
    band.set(present ? 100 : 0)
    tune(expand)
    expand.set(present && props.open ? 100 : 0)

    if (!present && props.open) props.onOpenChange(false)

    if (prefersReducedMotion()) {
      band.snap(band.target)
      expand.snap(expand.target)
      rows().forEach((row) => row.spring.snap(row.spring.target))
    }

    stop ??= frameLoop.add(step)
    paint()
  }

  const leave = (row: Row) => {
    row.hold = undefined
    tune(row.spring)
    row.spring.set(0)
    retarget()
  }

  const finish = (row: Row) => {
    row.setDone(true)

    if (expand.target > 0 && !prefersReducedMotion()) {
      row.hold = setTimeout(() => leave(row), HOLD)

      return
    }

    leave(row)
  }

  const revive = (row: Row) => {
    clearTimeout(row.hold)
    row.hold = undefined
    row.setDone(false)
    tune(row.spring)
    row.spring.set(100)
  }

  createEffect(
    on(
      () => props.subagents,
      (items) => {
        const keys = new Set(items.map((item) => item.key))
        const known = new Map(rows().map((row) => [row.key, row]))

        rows().forEach((row) => {
          if (!keys.has(row.key) && !row.done()) return finish(row)

          if (keys.has(row.key) && row.done()) revive(row)
        })
        items.forEach((item) => known.get(item.key)?.setItem(item))

        const added = items.filter((item) => !known.has(item.key)).map((item) => create(item, 0))

        if (added.length > 0) setRows([...rows(), ...added])
        retarget()
      },
      { defer: true },
    ),
  )

  createEffect(on(() => props.open, retarget, { defer: true }))

  onMount(() => {
    paint()

    makeEventListener(document, "pointerdown", (event) => {
      if (!props.open || !root || root.contains(event.target as Node)) return
      props.onOpenChange(false)
    })

    makeEventListener(document, "keydown", (event) => {
      if (!props.open || event.key !== "Escape" || event.defaultPrevented) return
      event.preventDefault()
      props.onOpenChange(false)
    })
  })

  onCleanup(() => {
    stop?.()
    rows().forEach((row) => clearTimeout(row.hold))
  })

  function step(dt: number) {
    band.step(dt)
    expand.step(dt)
    rows().forEach((row) => row.spring.step(dt))
    paint()

    const gone = rows().filter(
      (row) => row.done() && row.hold === undefined && row.spring.resting && row.spring.value === 0,
    )

    if (gone.length > 0) setRows(rows().filter((row) => !gone.includes(row)))

    if (band.resting && expand.resting && rows().every((row) => row.spring.resting)) {
      stop = undefined

      return false
    }

    return true
  }

  function paint() {
    if (!spacer || !surface || !clip || !list || !header || !chevron || !hairline) return

    const p = unit(band.value)
    const e = unit(expand.value)
    const content = rows().reduce((sum, row) => sum + unit(row.spring.value) * ROW, 0)
    const shown = Math.min(MAX, content > 0 ? content + INSET : 0) * e
    const height = BAND * p

    spacer.style.height = `${height}px`
    surface.style.top = `${-shown}px`
    clip.style.height = `${height + shown}px`
    list.style.height = `${Math.min(MAX, content + INSET)}px`
    // The band's words wait until most of its height is out, so they never sit cut by the rising edge.
    header.style.opacity = `${ease(Math.max(0, p - 0.4) / 0.6)}`
    header.style.transform = `translateY(${(1 - p) * 6}px)`
    hairline.style.opacity = `${p}`
    chevron.style.transform = `rotate(${180 - e * 180}deg)`
    list.inert = e === 0
    list.toggleAttribute("data-overflow", content + INSET > MAX)

    // Rows read bottom-up from the band. Each fades in as the sheet's top edge passes it, rising the way it grows.
    rows().reduceRight((offset, row) => {
      const presence = unit(row.spring.value)
      const reveal = Math.min(1, Math.max(0, (shown - INSET * e - offset) / (presence * ROW || ROW)))

      if (row.slot) row.slot.style.height = `${presence * ROW}px`

      if (row.body) {
        row.body.style.opacity = `${ease(reveal) * presence * presence}`
        row.body.style.transform = `translateY(${(1 - reveal) * 8}px)`
      }

      return offset + presence * ROW
    }, 0)
  }

  const agent = (item: SessionActivitySubagent) =>
    item.agent ? `${item.agent[0]!.toUpperCase()}${item.agent.slice(1)}` : language.t("ui.tool.agent.default")

  const clock = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`

  return (
    <div ref={root} data-component="composer-sheet" data-open={props.open || undefined}>
      <div ref={surface} data-slot="composer-sheet-surface" />
      <div ref={spacer} data-slot="composer-sheet-band" class="relative">
        <div ref={hairline} data-slot="composer-sheet-hairline" />
        <div
          ref={clip}
          data-slot="composer-sheet-clip"
          class="absolute inset-x-0 bottom-0 flex flex-col justify-end text-[13px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px]"
        >
          <div ref={list} data-slot="composer-sheet-list" class="shrink-0 overflow-y-auto px-2 pt-1">
            <For each={rows()}>
              {(row) => (
                <div ref={(element) => (row.slot = element)} class="flex items-center overflow-hidden">
                  <div
                    ref={(element) => (row.body = element)}
                    data-slot="composer-sheet-row"
                    data-done={row.done() || undefined}
                    role="button"
                    tabIndex={0}
                    class="group/sheet-row flex h-8 w-full min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-md ps-1.5 hover:bg-v2-overlay-simple-overlay-hover"
                    onClick={() => props.onOpen(row.item())}
                    onKeyDown={(event) => {
                      if (event.key !== "Enter" && event.key !== " ") return
                      event.preventDefault()
                      props.onOpen(row.item())
                    }}
                  >
                    <span class="relative size-4 shrink-0 text-v2-icon-icon-muted">
                      <span data-slot="composer-sheet-running" class="absolute inset-0 flex">
                        <SessionProgressIndicatorV2 />
                      </span>
                      <span data-slot="composer-sheet-check" class="absolute inset-0 flex items-center justify-center">
                        <Icon name="check-small" size="small" />
                      </span>
                    </span>
                    <span class="shrink-0 font-[530] text-v2-text-text-base">{agent(row.item())}</span>
                    <span dir="auto" class="min-w-0 flex-1 truncate text-v2-text-text-muted">
                      {row.item().label}
                    </span>
                    <span
                      class="shrink-0 pe-1.5 tabular-nums text-v2-text-text-faint"
                      classList={{ "group-hover/sheet-row:hidden": !!props.onStop && !row.done() }}
                    >
                      <Show when={row.item().started !== undefined}>
                        {clock(Math.max(0, Math.floor((now() - row.item().started!) / 1000)))}
                      </Show>
                    </span>
                    <Show when={props.onStop && !row.done()}>
                      <IconButton
                        type="button"
                        size="small"
                        variant="ghost-muted"
                        tabIndex={-1}
                        class="hidden group-hover/sheet-row:flex"
                        icon={<Icon name="outline-xmark" />}
                        aria-label={language.t("session.running.stop.subagent")}
                        onClick={(event) => {
                          event.stopPropagation()
                          props.onStop?.(row.item())
                        }}
                      />
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </div>
          <div ref={header} class="flex h-9 shrink-0 items-center px-2">
            <button
              type="button"
              data-slot="composer-sheet-toggle"
              aria-expanded={props.open}
              class="flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md ps-1.5 pe-1.5 text-start text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover focus-visible:outline-none focus-visible:bg-v2-overlay-simple-overlay-hover"
              onClick={() => props.onOpenChange(!props.open)}
            >
              <SessionProgressIndicatorV2 class="shrink-0 text-v2-icon-icon-muted" />
              <span class="flex min-w-0 items-baseline truncate whitespace-pre tabular-nums">
                {summary()[0]}
                <AnimatedNumber value={count()} />
                {summary()[1]}
              </span>
              <span class="flex-1" />
              <span class="flex items-baseline tabular-nums text-v2-text-text-faint">
                <AnimatedNumber value={Math.floor(elapsed() / 60)} />:
                <AnimatedNumber value={Math.floor((elapsed() % 60) / 10)} />
                <AnimatedNumber value={elapsed() % 10} />
              </span>
              <span ref={chevron} class="flex size-4 shrink-0 items-center justify-center text-v2-icon-icon-faint">
                <Icon name="chevron-down" size="small" />
              </span>
            </button>
          </div>
        </div>
      </div>
      <div class="relative">{props.children}</div>
    </div>
  )
}

function create(item: SessionActivitySubagent, from: number): Row {
  const [value, setItem] = createSignal(item)
  const [done, setDone] = createSignal(false)
  const spring = new Spring(from)
  const tuning = composerSheetSpring()
  spring.omega = (2 * Math.PI) / tuning.duration
  spring.zeta = 1 - tuning.bounce
  spring.set(100)

  return { key: item.key, item: value, setItem, done, setDone, spring }
}

const unit = (value: number) => Math.min(1, Math.max(0, value / 100))

const ease = (value: number) => value * value * (3 - 2 * value)
