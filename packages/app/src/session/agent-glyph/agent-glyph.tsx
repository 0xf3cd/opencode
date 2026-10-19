import { frameLoop, observeReducedMotion, prefersReducedMotion } from "@opencode/ui/motion"
import { createEffect, on, onCleanup, onMount } from "solid-js"
import { ActivityGyro, type AgentActivity } from "./gyro"
import { drawOrb, orbMargin, readPalette, type OrbPalette } from "./orb"
import "./agent-glyph.css"

export type { AgentActivity } from "./gyro"

// Live-tunable: how fast the glyphs' own time runs (the story and the motion panel set it).
export const agentGlyphTuning = { speed: 1 }

let seeds = 0

// Theme changes repaint resting glyphs, which otherwise draw nothing new.
const repaints = new Set<() => void>()

let themeObserver: MutationObserver | undefined

function watchTheme(repaint: () => void) {
  repaints.add(repaint)
  themeObserver ??= new MutationObserver(() => repaints.forEach((item) => item()))

  if (repaints.size === 1) {
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style", "data-theme"],
    })
  }

  return () => {
    repaints.delete(repaint)

    if (repaints.size === 0) themeObserver?.disconnect()
  }
}

// The agent activity glyph, ported from the iOS app's `AgentActivityGlyph`: a small LED orb whose dots draw one of
// Kit's designs per state, morphing with momentum from one to the next. It draws only while something moves or
// cools; Done and Failed flash, settle and stop; reduced motion shows each state's still pose.
export function AgentGlyph(props: {
  activity: AgentActivity
  // Where a new glyph starts before moving to `activity`, so a glyph mounted for a fresh change still shows it.
  from?: AgentActivity
  // The layout box; the glow spills past it.
  size?: number
  // Hidden behind something: hold the pose and draw nothing new.
  paused?: boolean
  class?: string
}) {
  let canvas: HTMLCanvasElement | undefined
  const size = () => props.size ?? 16
  const seed = (seeds++ % 97) / 13
  let gyro = new ActivityGyro(props.from ?? props.activity, prefersReducedMotion(), seed)
  let palette: OrbPalette | undefined
  let scale = 1
  let remove: (() => void) | undefined

  const paint = (dt: number) => {
    if (!canvas) return
    const ctx = canvas.getContext("2d")

    if (!ctx) return
    palette ??= readPalette(canvas)
    drawOrb(ctx, gyro.render(dt), size(), scale, palette)
  }

  const job = (frame: number) => {
    // Steps never longer than 1/30 s, so a dropped frame slows the orb rather than jumping it.
    const dt = Math.min(1 / 30, frame) * agentGlyphTuning.speed

    for (let remaining = dt; remaining > 1e-6; remaining -= 1 / 30) gyro.step(Math.min(1 / 30, remaining))
    paint(dt)

    if (!gyro.isResting && !props.paused && canvas?.isConnected) return true
    remove = undefined

    return false
  }

  const wake = () => {
    if (!remove && !props.paused) remove = frameLoop.add(job)
  }

  const resize = () => {
    if (!canvas) return
    // CSS zoom enlarges the canvas too, so its backing store follows.
    scale = (window.devicePixelRatio || 1) * canvas.currentCSSZoom
    const side = size() + 2 * orbMargin(size())
    canvas.width = Math.round(side * scale)
    canvas.height = Math.round(side * scale)
    canvas.style.width = `${side}px`
    canvas.style.height = `${side}px`
    canvas.style.margin = `${-orbMargin(size())}px`
  }

  onMount(() => {
    if (gyro.op !== props.activity) gyro.set(props.activity)
    resize()
    paint(0)
    wake()
    onCleanup(
      watchTheme(() => {
        palette = undefined
        paint(0)
      }),
    )
    onCleanup(
      observeReducedMotion(() => {
        gyro = new ActivityGyro(gyro.op, prefersReducedMotion(), seed)
        paint(0)
        wake()
      }),
    )
  })

  createEffect(
    on(
      () => props.activity,
      (activity) => {
        if (gyro.op === activity) return
        gyro.set(activity)
        wake()
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.paused,
      (paused) => {
        if (!paused) wake()
      },
      { defer: true },
    ),
  )
  createEffect(on(size, resize, { defer: true }))
  onCleanup(() => remove?.())

  return (
    <span
      data-component="agent-glyph"
      data-activity={props.activity}
      class={props.class}
      style={{ width: `${size()}px`, height: `${size()}px` }}
      aria-hidden="true"
    >
      <canvas ref={canvas} />
    </span>
  )
}
