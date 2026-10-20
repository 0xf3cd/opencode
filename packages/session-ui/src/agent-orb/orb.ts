// One page-wide loop steps and draws every mounted orb. It runs only while a visible orb is still moving and the
// window is shown and focused, so resting orbs (and a hidden or background window) cost no GPU time at all.

import { observeReducedMotion, prefersReducedMotion } from "@opencode/ui/motion"
import { ActivityGyro, SEVEN, SQUARE_SEVEN, type Activity } from "./gyro"
import { OrbRenderer, margin, pack, type Tile } from "./render"
import { ShellOutputFeed, ShellPromptGlyph } from "./shell"

export type AgentOrbState = Activity | "shell"

// Shells report no byte rate to the app, so the prompt laps at the iOS lab's nominal 800 B/s while one runs.
const SHELL_RATE = ShellOutputFeed.chunkRate(800)

const SHELL_STEP = 1 / 120

// Both layers keep drawing while the orb and the shell prompt blur-fade into each other.
const SWAP_SECONDS = 0.4

const orbs = new Set<Orb>()

let renderer: OrbRenderer | null | undefined

let frame: number | undefined

let last: number | undefined

let focused = true

let seeds = 0

let teardown: (() => void) | undefined

export class Orb {
  visible = false
  private gyro: ActivityGyro
  private shell: ShellPromptGlyph | undefined
  private feed = new ShellOutputFeed(7 + seeds)
  private pending = 0
  private swap = 0
  private dirty = true
  private seed = (seeds++ % 97) / 13
  private reduce = prefersReducedMotion()
  private packed = { orb: new Float32Array(268), shell: new Float32Array(268) }

  constructor(
    private host: HTMLElement,
    private layers: { orb: HTMLCanvasElement; shell: HTMLCanvasElement },
    private size: number,
    public state: AgentOrbState,
  ) {
    this.gyro = new ActivityGyro(state === "shell" ? "idle" : state, this.reduce, this.seed)
    orbs.add(this)
    start()
    observe(host, this)
  }

  set(state: AgentOrbState) {
    if (state === this.state) return
    const swapping = (state === "shell") !== (this.state === "shell")
    this.state = state

    if (state !== "shell") this.gyro.set(state)

    if (swapping) this.swap = SWAP_SECONDS
    this.dirty = true
    wake()
  }

  show(visible: boolean) {
    this.visible = visible
    this.dirty ||= visible
    wake()
  }

  invalidate() {
    this.dirty = true
  }

  reset() {
    this.reduce = prefersReducedMotion()
    this.gyro = new ActivityGyro(this.state === "shell" ? "idle" : this.state, this.reduce, this.seed)
    this.shell = undefined
    this.dirty = true
  }

  dispose() {
    observer?.unobserve(this.host)
    visibility.delete(this.host)
    orbs.delete(this)

    if (orbs.size === 0) stop()
  }

  get animating() {
    return this.dirty || this.swap > 0 || this.state === "shell" || !this.gyro.isResting
  }

  advance(dt: number, scale: number, dark: boolean, tiles: Tile[]) {
    const forced = this.dirty
    const shown = this.state === "shell"
    this.dirty = false
    this.swap = Math.max(0, this.swap - dt)

    if (!shown || this.swap > 0) this.advanceOrb(dt, scale, dark, forced, tiles)

    if (shown || this.swap > 0) this.advanceShell(dt, scale, dark, tiles)
  }

  private advanceOrb(dt: number, scale: number, dark: boolean, forced: boolean, tiles: Tile[]) {
    const steps = Math.ceil(dt * 30)
    Array.from({ length: steps }, () => this.gyro.step(dt / steps))

    if (this.gyro.isResting && !forced) return
    pack(this.gyro.render(SEVEN, dt), SEVEN, this.size, dark, scale, this.packed.orb)
    tiles.push({
      ctx: context(this.layers.orb, this.size, scale),
      side: this.layers.orb.width,
      packed: this.packed.orb,
    })
  }

  private advanceShell(dt: number, scale: number, dark: boolean, tiles: Tile[]) {
    this.shell ??= new ShellPromptGlyph("output", this.reduce, this.seed)
    const shell = this.shell
    const rate = this.state === "shell" ? SHELL_RATE : 0
    this.pending += dt
    const steps = Math.floor(this.pending / SHELL_STEP)
    this.pending -= steps * SHELL_STEP
    Array.from({ length: steps }, () => {
      if (!this.reduce) this.feed.chunks(rate, SHELL_STEP).forEach((weight) => shell.event(weight))
      shell.step(SHELL_STEP)
    })
    pack(
      shell.fill(SQUARE_SEVEN, Math.max(steps * SHELL_STEP, SHELL_STEP)),
      SQUARE_SEVEN,
      this.size,
      dark,
      scale,
      this.packed.shell,
    )
    tiles.push({
      ctx: context(this.layers.shell, this.size, scale),
      side: this.layers.shell.width,
      packed: this.packed.shell,
    })
  }
}

/** Whether orbs can draw at all; without WebGL2 the component shows its static mark. */
export function orbsAvailable() {
  if (renderer === undefined) renderer = OrbRenderer.create() ?? null

  return renderer !== null
}

function context(canvas: HTMLCanvasElement, size: number, scale: number) {
  const side = Math.round((size + 2 * margin(size)) * scale)

  if (canvas.width !== side) {
    canvas.width = side
    canvas.height = side
  }

  return canvas.getContext("2d")!
}

function dark() {
  const scheme = document.documentElement.dataset.colorScheme

  if (scheme === "dark" || scheme === "light") return scheme === "dark"

  return matchMedia("(prefers-color-scheme: dark)").matches
}

function runnable() {
  return document.visibilityState === "visible" && focused && [...orbs].some((orb) => orb.visible && orb.animating)
}

function wake() {
  if (frame === undefined && renderer && runnable()) frame = requestAnimationFrame(tick)
}

function tick(ms: number) {
  frame = undefined
  const now = ms / 1000
  // A paused loop resumes from where each orb stopped instead of jumping ahead by the time it slept.
  const dt = last === undefined ? 0 : Math.min(1 / 30, Math.max(0, now - last))
  const scale = Math.min(3, window.devicePixelRatio || 1)
  const scheme = dark()
  const tiles: Tile[] = []
  last = now
  orbs.forEach((orb) => {
    if (orb.visible) orb.advance(dt, scale, scheme, tiles)
  })
  renderer?.draw(tiles)

  if (runnable()) {
    frame = requestAnimationFrame(tick)

    return
  }

  last = undefined
}

function start() {
  if (teardown) return
  focused = document.hasFocus()

  const redraw = () => {
    orbs.forEach((orb) => orb.invalidate())
    wake()
  }

  const focus = () => {
    focused = true
    wake()
  }

  const blur = () => {
    focused = false
  }

  const scheme = matchMedia("(prefers-color-scheme: dark)")
  const attributes = new MutationObserver(redraw)

  const motion = observeReducedMotion(() => {
    orbs.forEach((orb) => orb.reset())
    wake()
  })

  attributes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-color-scheme"] })
  scheme.addEventListener("change", redraw)
  window.addEventListener("resize", redraw)
  document.addEventListener("visibilitychange", wake)
  window.addEventListener("focus", focus)
  window.addEventListener("blur", blur)
  teardown = () => {
    attributes.disconnect()
    motion()
    scheme.removeEventListener("change", redraw)
    window.removeEventListener("resize", redraw)
    document.removeEventListener("visibilitychange", wake)
    window.removeEventListener("focus", focus)
    window.removeEventListener("blur", blur)
  }
}

function stop() {
  teardown?.()
  teardown = undefined

  if (frame !== undefined) cancelAnimationFrame(frame)
  frame = undefined
  last = undefined
}

const visibility = new WeakMap<Element, Orb>()

let observer: IntersectionObserver | undefined

function observe(host: HTMLElement, orb: Orb) {
  if (!("IntersectionObserver" in globalThis)) return orb.show(true)
  observer ??= new IntersectionObserver((entries) =>
    entries.forEach((entry) => visibility.get(entry.target)?.show(entry.isIntersecting)),
  )
  visibility.set(host, orb)
  observer.observe(host)
}
