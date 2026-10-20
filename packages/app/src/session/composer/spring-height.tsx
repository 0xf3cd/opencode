import { createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { growthSpring } from "@/session/timeline/row-growth"

const grid = (value: number) => Math.round(value * 64) / 64

/**
 * A part of the composer region that comes, goes or changes height, like the queue. Its top edge moves on the
 * timeline's growth spring, so a followed timeline end rides it instead of jumping, and what it holds slides out from
 * behind the card below, so its text is never cut at the top. Present when it mounts, it starts at rest.
 */
export function SpringHeight(props: { when: boolean; class?: string; slot?: string; children: JSX.Element }) {
  const [present, setPresent] = createSignal(props.when)
  let outer: HTMLDivElement | undefined
  let inner: HTMLDivElement | undefined
  let spring: Spring | undefined
  let stop: (() => void) | undefined
  let measured = -1

  // A skirt tucked under the card below (a negative bottom margin) stays drawn; what is past it fades out behind a
  // soft edge that narrows as the height lands.
  const clip = (element: HTMLDivElement, shown: number, skirt: number) => {
    const margin = Math.min(skirt, Math.max(0, shown))
    const edge = Math.min(16, shown, Math.abs((spring?.target ?? shown) - shown))
    element.style.height = `${shown}px`
    element.style.overflowClipMargin = `${margin}px`

    if (edge < 0.5) return element.style.removeProperty("mask")
    element.style.mask = `linear-gradient(to bottom, #000 calc(100% - ${edge.toFixed(2)}px), transparent) 0 0 / 100% calc(100% + ${margin}px) no-repeat border-box no-clip`
  }

  const rest = (element: HTMLDivElement) => {
    stop?.()
    stop = undefined
    spring = undefined
    ;["overflow", "overflow-clip-margin", "mask", "height"].forEach((prop) => element.style.removeProperty(prop))

    if (!props.when) setPresent(false)
  }

  const move = (to: number) => {
    const element = outer

    if (!element) return

    if (prefersReducedMotion()) return rest(element)
    const last = inner?.lastElementChild
    const skirt = last ? Math.max(0, -parseFloat(getComputedStyle(last).marginBottom) || 0) : 0
    spring ??= Spring.fromDuration(measured >= 0 ? measured : element.getBoundingClientRect().height, growthSpring())
    spring.set(to)
    element.style.overflow = "clip"
    clip(element, grid(spring.value), skirt)
    stop ??= frameLoop.add((dt) => {
      const value = spring!.step(dt)

      if (spring!.resting) {
        rest(element)

        return false
      }

      clip(element, grid(value), skirt)

      return true
    })
  }

  createEffect(
    on(
      () => props.when,
      (when) => {
        if (when && present()) return move(inner?.getBoundingClientRect().height ?? 0)

        if (when) {
          measured = 0

          return setPresent(true)
        }

        move(0)
      },
      { defer: true },
    ),
  )

  onCleanup(() => stop?.())

  return (
    <Show when={present()}>
      <div
        ref={(element) => {
          outer = element

          if (measured === 0 && !prefersReducedMotion()) {
            element.style.height = "0px"
            element.style.overflow = "clip"
          }
        }}
        data-slot={props.slot}
        class={`flex flex-col ${props.class ?? ""}`}
      >
        <div
          class="shrink-0"
          ref={(element) => {
            inner = element

            const observer = new ResizeObserver((entries) => {
              const size = grid(entries[0]?.borderBoxSize[0]?.blockSize ?? element.getBoundingClientRect().height)

              if (size === measured || !props.when) return

              if (measured >= 0) move(size)
              measured = size
            })

            observer.observe(element, { box: "border-box" })
            onCleanup(() => observer.disconnect())
          }}
        >
          {props.children}
        </div>
      </div>
    </Show>
  )
}
