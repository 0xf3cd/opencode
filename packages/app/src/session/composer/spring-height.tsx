import { createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js"
import { frameLoop, prefersReducedMotion, Spring } from "@opencode/ui/motion"
import { growthSpring } from "@/session/timeline/row-growth"

/**
 * A part of the composer region that comes, goes or changes height, like the queue. Its top edge moves on the
 * timeline's growth spring, so a followed timeline end rides it instead of jumping, and what it holds rises from behind
 * the card below. Present when it mounts, it starts at rest.
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

    if (prefersReducedMotion()) return rest(element, to)
    spring ??= Spring.fromDuration(element.offsetHeight, growthSpring())
    spring.set(to)
    element.style.overflow = "clip"
    stop ??= frameLoop.add((dt) => {
      const value = spring!.step(dt)

      if (!spring!.resting) {
        element.style.height = `${value}px`

        return true
      }

      rest(element, spring!.target)

      return false
    })
  }

  const rest = (element: HTMLDivElement, size: number) => {
    stop?.()
    stop = undefined
    spring = undefined
    element.style.removeProperty("overflow")
    element.style.removeProperty("height")

    if (size === 0 && !props.when) setPresent(false)
  }

  createEffect(
    on(
      () => props.when,
      (when) => {
        // Back before it finished leaving: it grows again from where it is.
        if (when && present()) return move(inner?.offsetHeight ?? 0)

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
            element.style.overflow = "clip"
          }
        }}
        data-slot={props.slot}
        class={`flex flex-col justify-end ${props.class ?? ""}`}
      >
        <div
          ref={(element) => {
            inner = element

            const observer = new ResizeObserver((entries) => {
              const size = Math.round(entries[0]?.borderBoxSize[0]?.blockSize ?? element.offsetHeight)

              if (size === measured || !props.when) return

              const first = measured < 0
              measured = size

              if (!first) move(size)
            })

            observer.observe(element)
            onCleanup(() => observer.disconnect())
          }}
        >
          {props.children}
        </div>
      </div>
    </Show>
  )
}
