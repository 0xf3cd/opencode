import { createEffect, createSignal, on, onCleanup, Show, type JSX } from "solid-js"
import { frameLoop, observeReducedMotion, prefersReducedMotion, Spring } from "@opencode/ui/motion"

const spring = { duration: 0.4, bounce: 0 }

/**
 * When `watch` changes, springs from its previous height to what its content needs; otherwise rests at natural height.
 * Whole pixels, so the timeline's whole-pixel inset moves on the same frame. With `bottom` a taller card grows out of
 * the top; without, the content slides out from behind the card below, past a tucked `skirt`. `when` false closes it
 * before unmounting. Reduced motion skips the travel.
 */
export function SpringHeight(props: {
  watch: unknown
  when?: boolean
  bottom?: boolean
  skirt?: number
  class?: string
  children: JSX.Element
}) {
  const [present, setPresent] = createSignal(props.when !== false)
  let outer: HTMLDivElement | undefined
  let inner: HTMLDivElement | undefined
  let height: Spring | undefined
  let stop: (() => void) | undefined
  let size = 0
  let target = 0
  let opening = false

  const rest = () => {
    stop?.()
    stop = undefined
    height = undefined
    outer?.removeAttribute("data-moving")
    for (const prop of ["height", "overflow", "overflow-clip-margin"]) outer?.style.removeProperty(prop)

    if (props.when === false) setPresent(false)
  }

  const move = () => {
    if (!outer || prefersReducedMotion()) return rest()
    height ??= Spring.fromDuration(size, spring)
    outer.dataset.moving = ""
    outer.style.overflow = "clip"
    outer.style.overflowClipMargin = `${props.skirt ?? 0}px`
    outer.style.height = `${Math.round(height.value)}px`
    stop ??= frameLoop.addMeasured(
      () => {
        target = props.when === false ? 0 : (inner?.offsetHeight ?? 0)
      },
      (dt) => {
        height!.set(target).step(dt)

        if (height!.resting) {
          rest()

          return false
        }
        outer!.style.height = `${Math.round(height!.value)}px`

        return true
      },
    )
  }

  createEffect(
    on(
      () => [props.watch, props.when],
      () => {
        if (props.when === false || present()) return move()
        size = 0
        opening = true
        setPresent(true)
      },
      { defer: true },
    ),
  )

  onCleanup(observeReducedMotion(() => prefersReducedMotion() && rest()))
  onCleanup(() => stop?.())

  return (
    <Show when={present()}>
      <div
        ref={(element) => {
          outer = element
          // The height it had before a change, for the spring to start from.
          const observer = new ResizeObserver(() => {
            if (!height) size = element.offsetHeight
          })

          observer.observe(element)
          onCleanup(() => observer.disconnect())

          if (opening) move()
          opening = false
        }}
        class={`flex flex-col ${props.bottom ? "justify-end" : ""} ${props.class ?? ""}`}
      >
        <div ref={inner} class="flex shrink-0 flex-col">
          {props.children}
        </div>
      </div>
    </Show>
  )
}
