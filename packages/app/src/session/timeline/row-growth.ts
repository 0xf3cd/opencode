import { batch } from "solid-js"
import { frameLoop, Spring } from "@opencode/ui/motion"
import { motionTuning } from "@opencode/ui/motion-tuning"

const group = "Timeline"

// Like the iOS transcript: while the timeline follows its end, a row's displayed height springs to its measured height.
export const growthSpring = motionTuning.spring("timeline.growth", {
  label: "Row growth",
  group,
  presets: {
    snappy: { duration: 0.32, bounce: 0 },
    smooth: { duration: 0.42, bounce: 0 },
    calm: { duration: 0.55, bounce: 0 },
  },
})

const softEdge = motionTuning.number("timeline.growth.softEdge", {
  label: "Soft edge",
  group,
  value: 28,
  min: 0,
  max: 64,
  step: 2,
  unit: "px",
})

type Growth = { spring: Spring; start: number }

/**
 * Rows whose displayed height eases toward their measured height, and a gap left by a row near the end that closes on
 * the same spring. Each frame `measure` reads layout before any writes, `resize` commits a displayed height and returns
 * the row's clipping wrapper (false once the row has left the list), and `settle` runs once after the sizes with how far
 * the rows still have to grow and how much of the gap is still open.
 */
export function createRowGrowth(input: {
  measure: () => void
  resize: (key: string, size: number) => HTMLElement | false | undefined
  settle: (state: { pending: number; held: number }) => void
}) {
  const growths = new Map<string, Growth>()
  let held: Spring | undefined
  let stop: (() => void) | undefined

  const step = (dt: number) => {
    let pending = 0

    batch(() =>
      growths.forEach((growth, key) => {
        const value = growth.spring.step(dt)
        const target = growth.spring.target
        const resting = growth.spring.resting
        // Whole pixels, like the scroll offset that rides them, so the end never shimmers between two of them.
        const shown = resting ? target : Math.round(value)
        const wrapper = input.resize(key, shown)

        if (wrapper === false) return growths.delete(key)

        if (resting) growths.delete(key)
        pending += target - shown

        if (wrapper) paintEdge(wrapper, resting ? 0 : Math.min(softEdge(), target - value, value - growth.start))
      }),
    )
    const space = held ? Math.max(0, Math.round(held.step(dt))) : 0

    if (held?.resting) held = undefined
    input.settle({ pending, held: space })

    if (growths.size > 0 || held) return true
    stop = undefined

    return false
  }

  const run = () => {
    stop ??= frameLoop.addMeasured(input.measure, step)
  }

  return {
    /** The height a growing row is heading for. */
    target: (key: string) => growths.get(key)?.spring.target,
    /** Starts a row at `from`, or bends a running growth toward `to` from its current height and speed. */
    grow(key: string, from: number, to: number) {
      const growth = growths.get(key) ?? { spring: Spring.fromDuration(from, growthSpring()), start: from }
      growth.spring.set(to)
      growths.set(key, growth)
      run()
    },
    /** Opens a gap of `size` more, which then closes on the growth spring. */
    hold(size: number) {
      held ??= Spring.fromDuration(0, growthSpring())
      held.value += size
      held.set(0)
      run()
    },
    /** Lands one row on `size` at once. */
    land(key: string, size: number) {
      growths.delete(key)
      const wrapper = input.resize(key, size)

      if (wrapper) paintEdge(wrapper, 0)
    },
    /** Lands every growing row on its measured height and closes the gap at once. */
    finish() {
      stop?.()
      stop = undefined
      held = undefined
      batch(() =>
        growths.forEach((growth, key) => {
          const wrapper = input.resize(key, growth.spring.target)

          if (wrapper) paintEdge(wrapper, 0)
        }),
      )
      growths.clear()
    },
  }
}

// The growing row's bottom fades out instead of a hard clip. The fade narrows as the row lands and never covers what
// was already shown when the growth began.
function paintEdge(wrapper: HTMLElement, fade: number) {
  if (fade < 0.5) return wrapper.style.removeProperty("mask-image")
  wrapper.style.setProperty("mask-image", `linear-gradient(to bottom, #000 calc(100% - ${fade.toFixed(2)}px), transparent)`)
}
