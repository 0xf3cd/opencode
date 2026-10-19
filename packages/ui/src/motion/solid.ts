import { createEffect, onCleanup } from "solid-js"
import { frameLoop } from "./loop"
import { observeReducedMotion, prefersReducedMotion } from "./reduced"
import { Spring } from "./spring"
import type { DurationOptions, SpringOptions } from "./spring"

export function springStyle<K extends string>(
  ref: () => HTMLElement | undefined,
  targets: () => Record<K, number>,
  apply: (el: HTMLElement, values: Record<K, number>) => void,
  options: SpringOptions & { snap?: () => boolean } = {},
): void {
  const springs = new Map<K, Spring>()
  let entries: { key: K; spring: Spring }[] = []
  // SAFETY: every key is written by the target effect before the first paint reads values.
  const values = {} as Record<K, number>
  let element: HTMLElement | undefined
  let remove: (() => void) | undefined

  const paint = (dt: number) => {
    if (!element) {
      remove = undefined

      return false
    }

    let moving = false
    const reduced = prefersReducedMotion() || Boolean(options.snap?.())

    for (let i = 0; i < entries.length; i++) {
      const { key, spring } = entries[i]!
      values[key] = reduced ? spring.snap(spring.target).value : spring.step(dt)
      moving = moving || !spring.resting
    }

    apply(element, values)

    if (!moving) remove = undefined

    return moving
  }

  const wake = () => {
    if (!remove && element) remove = frameLoop.add(paint)
  }

  const unsubscribe = observeReducedMotion(wake)
  createEffect(() => {
    const el = ref()
    const next = targets()
    const snap = options.snap?.() || prefersReducedMotion() || el !== element
    element = el

    for (const key of springs.keys()) {
      if (!(key in next)) {
        springs.delete(key)
        delete values[key]
      }
    }

    // SAFETY: next is the Record<K, number> returned by targets().
    for (const key of Object.keys(next) as K[]) {
      let spring = springs.get(key)

      if (!spring) {
        spring = new Spring(next[key], options)
        springs.set(key, spring)
      }

      spring.set(next[key])

      if (snap) spring.snap(next[key])
    }

    entries = Array.from(springs, ([key, spring]) => ({ key, spring }))
    // The write phase is shared with all measuring primitives, even on first run.
    wake()
  })
  onCleanup(() => {
    remove?.()
    unsubscribe()
  })
}

export function slidingHighlight(options: {
  container: () => HTMLElement | undefined
  highlight: () => HTMLElement | undefined
  selected: () => HTMLElement | undefined
  axis?: "y" | "x" | "both"
  /** While true, the highlight lands on its row instead of travelling there (content swapped wholesale). */
  snap?: () => boolean
  /** Called with the highlight's box each frame it's written, for what rides along with it. */
  paint?: (box: { x: number; y: number; width: number; height: number }) => void
  /** The curve for a trip of `distance` px (duration and bounce), set as each trip starts. Default ω 30, ζ 0.88. */
  spring?: (distance: number) => DurationOptions
}): void {
  const x = new Spring(0, { omega: 30, zeta: 0.88 })
  const y = new Spring(0, { omega: 30, zeta: 0.88 })
  const w = new Spring(0, { omega: 30, zeta: 0.88 })
  const h = new Spring(0, { omega: 30, zeta: 0.88 })
  let first = true
  createEffect(() => {
    const container = options.container()
    const highlight = options.highlight()
    const selected = options.selected()
    const axis = options.axis ?? "y"

    if (!container || !highlight || !selected) return
    let until = performance.now() + 420
    let remove: (() => void) | undefined

    const read = () => {
      if (performance.now() > until && !first) return

      // Children must share the container as offset parent (position: relative).
      if (options.spring && (selected.offsetLeft !== x.target || selected.offsetTop !== y.target)) {
        const curve = options.spring(Math.hypot(selected.offsetLeft - x.value, selected.offsetTop - y.value))

        for (const spring of [x, y, w, h]) {
          spring.omega = (2 * Math.PI) / curve.duration
          spring.zeta = 1 - curve.bounce
        }
      }

      x.set(selected.offsetLeft)
      y.set(selected.offsetTop)
      w.set(selected.offsetWidth)
      h.set(selected.offsetHeight)
    }

    const write = (dt: number) => {
      const snap = first || prefersReducedMotion() || Boolean(options.snap?.())

      if (snap) {
        x.snap(x.target)
        y.snap(y.target)
        w.snap(w.target)
        h.snap(h.target)
      }

      first = false
      x.step(dt)
      y.step(dt)
      w.step(dt)
      h.step(dt)
      highlight.style.transform = `translate3d(${axis === "y" ? 0 : x.value}px,${axis === "x" ? 0 : y.value}px,0)`

      if (axis !== "x") highlight.style.height = `${h.value}px`

      if (axis !== "y") highlight.style.width = `${w.value}px`
      options.paint?.({ x: x.value, y: y.value, width: w.value, height: h.value })
      const moving = !snap && (performance.now() < until || !x.resting || !y.resting || !w.resting || !h.resting)

      if (!moving) remove = undefined

      return moving
    }

    const wake = () => {
      until = performance.now() + 420

      if (!remove) remove = frameLoop.addMeasured(read, write)
    }

    wake()
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(wake)
    observer?.observe(container)
    observer?.observe(selected)
    const unsubscribe = observeReducedMotion(wake)
    onCleanup(() => {
      remove?.()
      observer?.disconnect()
      unsubscribe()
    })
  })
}

/** Clone only on target/content changes, measure its max-content box in the shared read phase. */
export function widthMorph(options: {
  ref: () => HTMLElement | undefined
  content: () => HTMLElement | undefined
  watch?: () => void
  spring?: () => DurationOptions
  inset?: number
}): void {
  let spring = Spring.fromDuration(0, { duration: 0.42, bounce: 0.18 })
  let first = true
  createEffect(() => {
    options.watch?.()
    const settings = options.spring?.()
    const el = options.ref()
    const content = options.content()

    if (!el || !content) return

    if (settings) {
      const next = Spring.fromDuration(spring.value, settings)
      next.velocity = spring.velocity
      spring = next
    }

    const originalContentWidth = content.style.width
    content.style.width = "100%"
    // SAFETY: a deep clone of an HTMLElement is an HTMLElement.
    const clone = content.cloneNode(true) as HTMLElement
    clone.removeAttribute("id")

    for (const node of clone.querySelectorAll("[id]")) node.removeAttribute("id")
    clone.setAttribute("aria-hidden", "true")
    clone.inert = true
    Object.assign(clone.style, {
      position: "absolute",
      visibility: "hidden",
      pointerEvents: "none",
      width: "max-content",
      maxWidth: "none",
      minWidth: "0",
      top: "0",
      left: "0",
    })
    el.append(clone)
    let measured = false
    let remove: (() => void) | undefined

    const read = () => {
      if (measured) return
      spring.set(clone.getBoundingClientRect().width + 2 * (options.inset ?? 4))
      measured = true
    }

    const write = (dt: number) => {
      if (first || prefersReducedMotion()) spring.snap(spring.target)
      first = false
      el.style.width = `${spring.step(dt)}px`
      clone.remove()
      const moving = !spring.resting

      if (!moving) remove = undefined

      return moving
    }

    remove = frameLoop.addMeasured(read, write)

    const unsubscribe = observeReducedMotion(() => {
      if (!remove) remove = frameLoop.addMeasured(read, write)
    })

    onCleanup(() => {
      remove?.()
      unsubscribe()
      clone.remove()
      content.style.width = originalContentWidth
    })
  })
}

export function numberTween(options: {
  ref: () => HTMLElement | undefined
  value: () => number
  format?: (value: number) => string
  omega?: number
  zeta?: number
  snap?: () => boolean
}): void {
  springStyle(
    options.ref,
    () => ({ value: options.value() }),
    (el, numbers) => {
      const text = options.format?.(numbers.value) ?? String(Math.round(numbers.value))

      if (el.textContent !== text) el.textContent = text
    },
    options,
  )
}

export { keyedPresence } from "./presence"

export { steppedSlider } from "./slider"
