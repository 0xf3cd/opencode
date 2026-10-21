import { frameLoop, observeReducedMotion, prefersReducedMotion } from "@opencode/ui/motion"
import { For, onCleanup, onMount } from "solid-js"
import { ActivityGyro, CELLS, type AgentActivity } from "./gyro"
import "./agent-orb.css"

// The 16px box holds a 7 × 7 grid on a 2px pitch, inset 1px, like the iOS orb at this size.
const PITCH = 2
const RADIUS = 0.42 * PITCH

let seeds = 0

// The iOS app's activity orb (`AgentActivityGlyph`), drawn with DOM dots instead of a canvas: the gyro engine from the
// agents-chip prototype lights each of the 37 dots, and every frame writes only their opacity and transform. A lit
// dot brightens from the muted icon colour toward the base text colour by crossfading two stacked discs. Reduced
// motion holds the state's still pose.
export function AgentOrb(props: { activity: AgentActivity; class?: string }) {
  const seed = (seeds++ % 97) / 13
  const discs: { base: HTMLSpanElement; core: HTMLSpanElement }[] = []
  let root: HTMLSpanElement | undefined
  let glow: HTMLSpanElement | undefined
  let gyro = new ActivityGyro(props.activity, prefersReducedMotion(), seed)
  let dark = false
  let remove: (() => void) | undefined

  const paint = (dt: number) => {
    const field = gyro.render(dt)
    const a0 = dark ? 0.06 : 0.075
    const top = dark ? 0.96 : 1

    CELLS.forEach((cell, i) => {
      const dot = field.dots[i]
      const disc = discs[i]

      if (!dot || !disc) return
      const P = Math.min(1, Math.max(0, dot.light))
      const fresh = Math.min(1, Math.max(0, dot.fresh))
      const shrink = 1 + (0.82 + 0.18 * fresh - 1) * smoothstep(0.03, 0.2, P)
      const radius = (0.25 + 0.17 * Math.pow(Math.max(P, 1e-5), 0.6)) * shrink * PITCH * dot.size
      const alpha = a0 + (top - a0) * Math.pow(Math.max(P, 1e-5), (dark ? 0.9 : 0.75) * (1.4 - 0.4 * fresh))
      const core = Math.min(0.9, P * P * 1.1) * (0.3 + 0.7 * fresh)
      const transform = `${place(cell.column, cell.row)} scale(${(radius / RADIUS).toFixed(3)})`
      disc.base.style.transform = transform
      disc.core.style.transform = transform
      disc.base.style.opacity = (alpha * (1 - core)).toFixed(3)
      disc.core.style.opacity = (alpha * core).toFixed(3)
    })

    if (glow) glow.style.opacity = (Math.min(1, field.glow) * (dark ? 0.25 : 0.07)).toFixed(3)
  }

  const job = (frame: number) => {
    // Steps never longer than 1/30 s, so a dropped frame slows the orb rather than jumping it.
    const dt = Math.min(1 / 30, frame)

    for (let remaining = dt; remaining > 1e-6; remaining -= 1 / 30) gyro.step(Math.min(1 / 30, remaining))
    paint(dt)

    if (!gyro.isResting && root?.isConnected) return true
    remove = undefined

    return false
  }

  const wake = () => {
    if (!remove) remove = frameLoop.add(job)
  }

  onMount(() => {
    if (!root) return
    dark = getComputedStyle(root).colorScheme.includes("dark")
    paint(0)
    wake()
    onCleanup(
      observeReducedMotion(() => {
        gyro = new ActivityGyro(gyro.op, prefersReducedMotion(), seed)
        paint(0)
        wake()
      }),
    )
  })

  onCleanup(() => remove?.())

  return (
    <span ref={root} data-component="agent-orb" class={props.class} aria-hidden="true">
      <span ref={glow} data-slot="agent-orb-glow" />
      <For each={CELLS}>
        {(cell, index) => (
          <>
            <span
              ref={(element) => (discs[index()] = { ...discs[index()]!, base: element })}
              data-slot="agent-orb-dot"
              style={{ transform: place(cell.column, cell.row) }}
            />
            <span
              ref={(element) => (discs[index()] = { ...discs[index()]!, core: element })}
              data-slot="agent-orb-dot"
              data-core
              style={{ transform: place(cell.column, cell.row) }}
            />
          </>
        )}
      </For>
    </span>
  )
}

const place = (column: number, row: number) =>
  `translate(${1 + (column + 0.5) * PITCH - RADIUS}px, ${1 + (row + 0.5) * PITCH - RADIUS}px)`

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))

  return t * t * (3 - 2 * t)
}
