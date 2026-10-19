import { frameLoop } from "./loop"
import { observeReducedMotion, prefersReducedMotion } from "./reduced"
import { Spring } from "./spring"

export interface SliderSpec {
  min: number
  max: number
  step: number
}

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))

function validate(spec: SliderSpec) {
  if (
    !Number.isFinite(spec.min) ||
    !Number.isFinite(spec.max) ||
    !Number.isFinite(spec.step) ||
    spec.max < spec.min ||
    spec.step <= 0
  )
    throw new RangeError("Invalid slider range")
}

/** Includes both endpoints. Non-divisible ranges include a final shorter interval. */
export function sliderStops(spec: SliderSpec): number {
  validate(spec)

  return Math.ceil((spec.max - spec.min) / spec.step - 1e-10) + 1
}

export function sliderValue(spec: SliderSpec, value: number): number {
  validate(spec)
  const nearest = spec.min + Math.round((value - spec.min) / spec.step) * spec.step
  const result = Math.abs(value - spec.max) < Math.abs(value - nearest) ? spec.max : nearest

  return Number(clamp(result, spec.min, spec.max).toPrecision(14))
}

export function sliderFraction(spec: SliderSpec, value: number): number {
  return spec.max === spec.min ? 0 : clamp((value - spec.min) / (spec.max - spec.min), 0, 1)
}

export function sliderStep(spec: SliderSpec, value: number, direction: -1 | 1, count = 1): number {
  const last = sliderStops(spec) - 1
  const current = value >= spec.max ? last : Math.round((value - spec.min) / spec.step)
  const index = clamp(current + direction * count, 0, last)

  return sliderValue(spec, Math.min(spec.max, spec.min + index * spec.step))
}

/** Callbacks receive targets on input, displayed values on paint; only onChange may write signals. */
export function steppedSlider(options: {
  el: HTMLElement
  spec: SliderSpec
  value: number
  onChange: (value: number) => void
  paint: (value: number, fraction: number) => void
  onReset?: () => void
  resetValue?: number
  onCommit?: (value: number) => void
}) {
  let spec = options.spec
  let continuous = sliderStops(spec) > 10
  let target = sliderValue(spec, options.value)
  const spring = new Spring(target, { omega: 34, zeta: 0.86 })
  let pointer: number | undefined
  let left = 0
  let width = 1
  let remove: (() => void) | undefined
  let disposed = false
  let reduced = prefersReducedMotion()
  const el = options.el
  const originalTouchAction = el.style.touchAction
  el.style.touchAction = "pan-y"
  el.setAttribute("role", "slider")

  if (!el.hasAttribute("tabindex")) el.tabIndex = 0

  const paint = (dt: number) => {
    if (reduced) spring.snap(target)
    const value = spring.step(dt)
    options.paint(value, sliderFraction(spec, value))
    const moving = spring.value !== spring.target || spring.velocity !== 0

    if (!moving) remove = undefined

    return moving
  }

  const wake = () => {
    if (!remove && !disposed) remove = frameLoop.add(paint)
  }

  const unsubscribe = observeReducedMotion(() => {
    reduced = prefersReducedMotion()
    wake()
  })

  const aria = () => {
    el.setAttribute("aria-valuemin", String(spec.min))
    el.setAttribute("aria-valuemax", String(spec.max))
    el.setAttribute("aria-valuenow", String(target))
    el.setAttribute("aria-orientation", "horizontal")
  }

  const set = (value: number, snap = false, notify = false) => {
    target = sliderValue(spec, value)

    spring.set(target)

    if (snap || reduced) spring.snap(target)
    aria()

    if (notify) options.onChange(target)
    wake()
  }

  const point = (event: PointerEvent) => {
    const value = spec.min + clamp((event.clientX - left) / width, 0, 1) * (spec.max - spec.min)
    set(value, continuous, true)
  }

  const down = (event: PointerEvent) => {
    if (event.button !== 0 || pointer !== undefined) return
    const rect = el.getBoundingClientRect()
    left = rect.left
    width = Math.max(1, rect.width)
    pointer = event.pointerId
    el.setPointerCapture?.(pointer)
    el.focus({ preventScroll: true })
    el.setAttribute("data-dragging", "")
    point(event)
  }

  const move = (event: PointerEvent) => {
    if (event.pointerId === pointer) point(event)
  }

  const up = (event: PointerEvent) => {
    if (event.pointerId !== pointer) return
    const id = pointer
    pointer = undefined
    el.removeAttribute("data-dragging")

    if (id !== undefined && el.hasPointerCapture?.(id)) el.releasePointerCapture(id)

    if (event.type === "pointerup") options.onCommit?.(target)
  }

  const reset = () => {
    if (options.onReset) {
      options.onReset()

      return
    }

    if (options.resetValue !== undefined) set(options.resetValue, false, true)
  }

  const keyTarget = (event: KeyboardEvent) => {
    const steps = event.shiftKey ? 10 : 1

    if (event.key === "ArrowLeft" || event.key === "ArrowDown") return sliderStep(spec, target, -1, steps)

    if (event.key === "ArrowRight" || event.key === "ArrowUp") return sliderStep(spec, target, 1, steps)

    if (event.key === "Home") return spec.min

    if (event.key === "End") return spec.max

    return undefined
  }

  const key = (event: KeyboardEvent) => {
    if (event.key === "Backspace") {
      event.preventDefault()
      reset()

      return
    }

    const next = keyTarget(event)

    if (next === undefined) return
    event.preventDefault()
    set(next, false, true) // Arrow keys glide between stops, like a stepped drag.
    options.onCommit?.(target)
  }

  const doubleClick = (event: MouseEvent) => {
    event.preventDefault()
    reset()
  }

  el.addEventListener("pointerdown", down)
  el.addEventListener("pointermove", move)
  el.addEventListener("pointerup", up)
  el.addEventListener("pointercancel", up)
  el.addEventListener("lostpointercapture", up)
  el.addEventListener("keydown", key)
  el.addEventListener("dblclick", doubleClick)
  aria()
  wake()

  return {
    set: (value: number, options: { snap?: boolean } = {}) => set(value, options.snap),
    configure: (next: SliderSpec) => {
      continuous = sliderStops(next) > 10
      spec = next
      set(target)
    },
    get value() {
      return target
    },
    get displayed() {
      return spring.value
    },
    dispose: () => {
      disposed = true
      remove?.()
      unsubscribe()

      if (pointer !== undefined && el.hasPointerCapture?.(pointer)) el.releasePointerCapture(pointer)
      el.style.touchAction = originalTouchAction
      el.removeAttribute("data-dragging")
      el.removeEventListener("pointerdown", down)
      el.removeEventListener("pointermove", move)
      el.removeEventListener("pointerup", up)
      el.removeEventListener("pointercancel", up)
      el.removeEventListener("lostpointercapture", up)
      el.removeEventListener("keydown", key)
      el.removeEventListener("dblclick", doubleClick)
    },
  }
}
