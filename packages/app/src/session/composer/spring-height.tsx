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

  const move = (to: number) => {
    const element = outer

    if (!element) return

    if (prefersReducedMotion()) return rest(element)

    if (!spring) {
      // A skirt tucked under the card below (a negative bottom margin) stays drawn; only what is past it is cut.
      const last = inner?.lastElementChild
      const skirt = last ? Math.max(0, -parseFloat(getComputedStyle(last).marginBottom) || 0) : 0
      element.style.clipPath = `inset(0 0 ${-skirt}px 0)`
      spring = Spring.fromDuration(element.getBoundingClientRect().height, growthSpring())
    }
    spring.set(to)
    element.style.height = `${grid(spring.value)}px`
    stop ??= frameLoop.add((dt) => {
      const value = spring!.step(dt)

      if (!spring!.resting) {
        element.style.height = `${grid(value)}px`

        return true
      }

      rest(element)

      return false
    })
  }

  // At rest it is as tall as what it holds, with nothing cut.
  const rest = (element: HTMLDivElement) => {
    stop?.()
    stop = undefined
    spring = undefined
    element.style.removeProperty("height")
    element.style.removeProperty("clip-path")

    if (!props.when) setPresent(false)
  }

  createEffect(
    on(
      () => props.when,
      (when) => {
        // Back before it finished leaving: it grows again from where it is.
        if (when && present()) return move(inner?.getBoundingClientRect().height ?? 0)

        if (when) {
          // Mounts collapsed; the first measurement grows it.
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

          if (measured === 0) {
            element.style.height = "0px"
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

              const first = measured < 0
              measured = size

              if (!first) move(size)
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
