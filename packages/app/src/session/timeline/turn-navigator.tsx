import type { SessionMessageAssistant, SessionMessageInfo, SessionMessageUser } from "@opencode/client/promise"
import { createEffect, createMemo, createSelector, For, onCleanup, onMount, Show, type Accessor } from "solid-js"
import { createStore } from "solid-js/store"
import { readPromptPresentation } from "@/composer/comment-note"
import { useServerSDK } from "@/runtime/server/client"

const turnPageLimit = 200

// Previews clamp to a few lines; keep only enough text to fill them.
const previewLength = 400

// How long after the timeline mounts the rail loads, clear of session entry and tab switch rendering.
const railDelay = 1000

// A pointer resting this long on an unloaded turn fetches its reply; sweeping across the rail fetches nothing.
const replyHoverDelay = 150

const previewHoverDelay = 100

const hoverRadius = 6

const tickWidths = { default: [7, 12], active: [12, 20], hovered: [14, 22] }

const tickSpanWidth = Math.max(...Object.values(tickWidths).flat())

type TurnNavigatorProps = {
  sessionID: string
  /** Loaded messages that have timeline rows; excludes queued inbox items. */
  messages: Accessor<SessionMessageInfo[]>
  /** Whether the loaded messages reach the start of the session, making the index redundant. */
  complete: Accessor<boolean>
  assistantMessagesByParent: Accessor<Map<string, SessionMessageAssistant[]>>
  revertMessageID: Accessor<string | undefined>
  visibleUserMessageIDs: Accessor<ReadonlySet<string>>
  onSelect: (id: string) => void
}

/**
 * A mouse rail of the session's user turns beside the timeline. While older history is unloaded, turns come from the
 * server's user-message index, and hovering an unloaded turn fetches only its latest reply. Keyboard users move
 * between turns with the previous and next message commands.
 *
 * Nothing loads or renders until shortly after the timeline mounts, which keeps the rail off session entry and tab
 * switches. The rail then appears once it lists every turn, so it never grows under the pointer.
 */
export function TurnNavigator(props: TurnNavigatorProps) {
  const sdk = useServerSDK()
  const [state, setState] = createStore<{ engaged: boolean; index?: Map<string, string> }>({ engaged: false })
  let root: HTMLDivElement | undefined

  const loadIndex = async (cursor?: string): Promise<[string, string][]> => {
    const page = await sdk.api.message.list({
      sessionID: props.sessionID,
      type: "user",
      limit: turnPageLimit,
      ...(cursor ? { cursor } : { order: "asc" as const }),
    })
    const turns = page.data.flatMap((message) =>
      message.type === "user" ? [[message.id, promptPreview(message)] as [string, string]] : [],
    )

    if (page.data.length < turnPageLimit || !page.cursor.next) return turns

    return [...turns, ...(await loadIndex(page.cursor.next))]
  }

  onMount(() => {
    const timer = setTimeout(() => {
      // The rail is a mouse affordance; touch-only devices never load it.
      if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return
      setState("engaged", true)

      if (props.complete()) return
      // Plain state rather than a resource: a pending resource would suspend the timeline it decorates.
      // On failure the rail lists the loaded turns.
      void loadIndex()
        .catch(() => [])
        .then((turns) => setState("index", new Map(turns)))
    }, railDelay)
    onCleanup(() => clearTimeout(timer))
  })

  return (
    <div
      ref={root}
      data-component="session-turn-navigator"
      aria-hidden="true"
      class="absolute start-0 top-14 bottom-20 z-[50] flex w-4 flex-col justify-center pointer-events-none"
    >
      <Show when={state.engaged && (props.complete() || state.index)}>
        <TurnRail {...props} index={state.index} root={root!} />
      </Show>
    </div>
  )
}

function TurnRail(props: TurnNavigatorProps & { index?: Map<string, string>; root: HTMLDivElement }) {
  const sdk = useServerSDK()
  // Fetched replies by user message ID; null while loading or when the turn has no reply text.
  const [state, setState] = createStore<{
    hover?: { id: string; top: number; position: number }
    showPreview: boolean
    replies: Record<string, string | null>
  }>({ showPreview: false, replies: {} })

  const loaded = createMemo(
    () =>
      new Map(props.messages().flatMap((message) => (message.type === "user" ? [[message.id, message] as const] : []))),
  )

  const turns = createMemo(() => {
    const revert = props.revertMessageID()

    return [...new Set([...(props.index?.keys() ?? []), ...loaded().keys()])]
      .filter((id) => !revert || id < revert)
      .toSorted()
  })

  // The turn's latest reply is the newest assistant message before the next turn.
  const loadReply = async (id: string) => {
    setState("replies", id, null)
    const list = turns()
    const next = list[list.indexOf(id) + 1] ?? props.revertMessageID()
    const page = await sdk.api.message.list({
      sessionID: props.sessionID,
      type: "assistant",
      limit: 1,
      ...(next ? { before: next } : {}),
    })
    const message = page.data[0]

    if (message?.type !== "assistant" || message.id < id) return
    setState("replies", id, replyText([message]) ?? null)
  }

  createEffect(() => {
    const id = state.hover?.id

    if (!id || loaded().has(id) || state.replies[id] !== undefined) return
    const timer = setTimeout(() => void loadReply(id).catch(() => undefined), replyHoverDelay)
    onCleanup(() => clearTimeout(timer))
  })

  const active = createSelector(props.visibleUserMessageIDs, (id: string, visible) => visible.has(id))
  const hovered = createSelector(() => state.hover?.id)
  const hovering = createMemo(() => !!state.hover)

  // Only the first preview waits; moving along an already engaged rail switches it immediately.
  createEffect(() => {
    if (!hovering()) {
      setState("showPreview", false)

      return
    }

    const timer = setTimeout(() => setState("showPreview", true), previewHoverDelay)
    onCleanup(() => clearTimeout(timer))
  })

  const tickScale = (id: string, index: number, proximity: number) => {
    // Hovered active ticks keep active color (`data-state`), while width expands to the hovered target.
    const widths = hovered(id) ? tickWidths.hovered : active(id) ? tickWidths.active : tickWidths.default

    return (widths[0] + (widths[1] - widths[0]) * (hovered(id) ? 1 : proximity)) / tickSpanWidth
  }

  const preview = createMemo(() => {
    const hover = state.hover

    if (!hover) return
    const message = loaded().get(hover.id)

    return {
      top: hover.top,
      prompt: message ? promptPreview(message) : props.index?.get(hover.id),
      response: message
        ? replyText(props.assistantMessagesByParent().get(hover.id) ?? [])
        : (state.replies[hover.id] ?? undefined),
    }
  })

  const turnAt = (event: MouseEvent) =>
    event.target instanceof Element ? event.target.closest<HTMLElement>("[data-turn]") : null

  const hover = (event: PointerEvent) => {
    const tick = turnAt(event)
    const id = tick?.dataset.turn

    if (!tick || !id) return
    const box = tick.getBoundingClientRect()
    const position = Number(tick.dataset.index) + (event.clientY - box.top) / box.height - 0.5

    if (state.hover?.id === id && Math.abs(state.hover.position - position) < 0.05) return
    setState("hover", {
      id,
      top: box.top + box.height / 2 - props.root.getBoundingClientRect().top,
      position,
    })
  }

  return (
    <Show when={turns().length > 1}>
      <div
        // Keep the expanded hit area while the visual emphasis follows the pointer locally.
        class="flex max-h-full min-h-0 w-4 cursor-pointer flex-col py-1 pointer-events-auto transition-[width] duration-150 hover:w-8 animate-in fade-in [animation-duration:180ms] [animation-timing-function:ease-out] motion-reduce:animate-none motion-reduce:transition-none"
        onPointerMove={hover}
        onPointerLeave={() => setState("hover", undefined)}
        onClick={(event) => {
          const id = turnAt(event)?.dataset.turn

          if (id) props.onSelect(id)
        }}
      >
        <For each={turns()}>
          {(id, index) => {
            const proximity = createMemo(() => {
              if (!state.hover) return 0
              const distance = Math.abs(index() - state.hover.position)

              if (distance >= hoverRadius) return 0
              return (1 + Math.cos((distance / hoverRadius) * Math.PI)) / 2
            })

            return (
              <div
                data-turn={id}
                data-index={index()}
                // Active color wins so a clicked or visible turn still reads as active under the pointer.
                data-state={active(id) ? "active" : hovered(id) ? "hovered" : "default"}
                class="flex h-2.5 min-h-0 w-full shrink items-center ps-2.5 [--tick-color:var(--v2-background-bg-layer-04)] [--tick-opacity:1] [[data-color-scheme=dark]_&]:data-[state=default]:[--tick-opacity:0.7] data-[state=active]:[--tick-color:var(--v2-icon-icon-muted)] [[data-color-scheme=dark]_&]:data-[state=active]:[--tick-color:var(--v2-icon-icon-base)] data-[state=hovered]:[--tick-color:var(--v2-icon-icon-faint)] [[data-color-scheme=dark]_&]:data-[state=hovered]:[--tick-color:var(--v2-icon-icon-muted)]"
              >
                <span
                  class="block h-0.5 shrink-0 origin-left bg-(--tick-color) transition-[transform,background-color,opacity] duration-150 ease-out rtl:origin-right motion-reduce:transition-none"
                  style={{
                    width: `${tickSpanWidth}px`,
                    transform: `scaleX(${tickScale(id, index(), proximity())})`,
                    opacity: "var(--tick-opacity)",
                  }}
                />
              </div>
            )
          }}
        </For>
      </div>
      <Show when={state.showPreview && preview()}>
        {(item) => (
          <div
            data-slot="session-turn-navigator-preview"
            class="pointer-events-none absolute start-11 top-0 w-[320px] max-w-[calc(100vw-4rem)] transition-transform duration-100 ease-out motion-reduce:transition-none"
            style={{ transform: `translateY(${item().top}px)` }}
          >
            <div
              class="-translate-y-1/2 rounded-lg bg-v2-background-bg-base px-3 py-2 animate-in fade-in duration-150 ease-out motion-reduce:animate-none"
              style={{ "box-shadow": "var(--v2-elevation-raised)" }}
            >
              <p class="line-clamp-2 text-[13px] font-[530] leading-text-compact text-v2-text-text-base">
                {item().prompt}
              </p>
              <Show when={item().response}>
                {(text) => (
                  <p class="mt-1 line-clamp-3 text-[13px] leading-text-base text-v2-text-text-muted">{text()}</p>
                )}
              </Show>
            </div>
          </div>
        )}
      </Show>
    </Show>
  )
}

function promptPreview(message: SessionMessageUser) {
  return previewText(readPromptPresentation(message.metadata)?.displayText ?? message.text)
}

function replyText(messages: SessionMessageAssistant[]) {
  const text = messages
    .flatMap((message) => message.content)
    .findLast((content) => content.type === "text" && content.text.trim())

  return text?.type === "text" ? previewText(text.text) : undefined
}

function previewText(text: string) {
  return text.replace(/\s+/g, " ").trim().slice(0, previewLength)
}
