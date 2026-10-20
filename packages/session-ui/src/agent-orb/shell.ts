// The iOS app's shell glyph (opencode-ios ShellPromptGlyph.swift, R1 Glide): a `>_`
// prompt on a square 7 × 7 LED field whose chevron laps with momentum driven by output.

import { G, GyroValue, smooth, type GyroCell, type GyroField, type GyroSpring } from "./gyro"

export const glide = {
  impulse: 0.75,
  tau: 0.9,
  mu: 3,
  quad: 0.012,
  push: 0.14,
  flowTau: 0.9,
  enter: 3.2,
  exit: 1.6,
  cruise: 2.4,
  nudge: 2.4,
}

const LAP = 7

type P = [number, number]

const CHEVRON: P[] = [
  [1, 1],
  [3, 3],
  [1, 5],
]

const CURSOR: P[] = [
  [4, 6],
  [4.5, 6],
  [5, 6],
]

const FADE = smooth(0.45),
  STILL = smooth(0.35),
  NUDGE: GyroSpring = { response: 0.38, damping: 0.72 }

function strokeLight(pts: P[], x: number, y: number, w: number) {
  let best = 0

  for (let s = 0; s < 2; s++) {
    const A = pts[s],
      B = pts[s + 1]

    const l = Math.hypot(B[0] - A[0], B[1] - A[1])
    let t = 0

    if (l > 1e-4) t = G.clamp(((x - A[0]) * (B[0] - A[0]) + (y - A[1]) * (B[1] - A[1])) / (l * l), 0, 1)

    const px = A[0] + (B[0] - A[0]) * t,
      py = A[1] + (B[1] - A[1]) * t

    best = Math.max(best, G.gauss(Math.hypot(x - px, y - py), w))
  }

  return best
}

function wrappedLight(pts: P[], x: number, y: number, w: number, offset: number) {
  if (Math.abs(offset) < 1e-4) return strokeLight(pts, x, y, w)
  const o = ((offset % LAP) + LAP) % LAP

  return Math.max(strokeLight(pts, x - o, y, w), strokeLight(pts, x - o + LAP, y, w))
}

const combine = (a: number, b: number) => 1 - (1 - a) * (1 - Math.min(1, b))

function stopDistance(v: number, tau: number, mu: number) {
  return tau * v - mu * tau * tau * Math.log(1 + v / (mu * tau))
}

function friction(v: number, tau: number, d: number) {
  let lo = 1e-3,
    hi = 1e3

  for (let i = 0; i < 40; i++) {
    const m = Math.sqrt(lo * hi)

    if (stopDistance(v, tau, m) > d) lo = m
    else hi = m
  }

  return Math.sqrt(lo * hi)
}

export class ShellPromptGlyph {
  state: "idle" | "output"
  phase: "rest" | "lap" | "coast" = "rest"
  x = 0
  v = 0
  flow = 0
  private t: number
  private reservoir = 0
  private lapAge = 0
  private home: number | null = null
  private nudge = new GyroValue(0, NUDGE, 0.001)
  private cursorK = new GyroValue(1, FADE, 0.002)
  private cursorY = new GyroValue(0, FADE, 0.002)
  private body = new GyroValue(0, FADE, 0.002)
  private glow = new GyroValue(0, FADE, 0.002)
  private chev = new GyroValue(0, FADE, 0.002)
  private blink = 1
  private light: number[] = []

  constructor(
    state: "idle" | "output",
    public reduceMotion = false,
    seed = 0,
  ) {
    this.state = state
    this.t = seed * 2.3
    this.set(state, true)
  }

  get offset() {
    return this.x + this.nudge.value
  }

  set(state: "idle" | "output", immediate = false) {
    this.state = state
    const now = immediate || this.reduceMotion
    const cfg = this.reduceMotion ? STILL : FADE
    this.body.to(state === "idle" ? 0.6 : 0.85, cfg, now)
    this.chev.to(state === "idle" ? 0.82 : 1, cfg, now)
    this.glow.to(state === "idle" ? 0.16 : 0.3, cfg, now)
  }

  event(w = 1) {
    if (this.reduceMotion) return
    const C = glide
    this.flow = Math.min(C.enter * 1.6, this.flow + w / C.flowTau)

    if (this.phase === "rest") {
      if (this.flow >= C.enter) this.startLap(w)
      else this.nudge.velocity += C.nudge * w
    } else {
      this.reservoir += C.impulse * w

      if (this.phase === "coast") this.home = null
    }
  }

  private plan() {
    const C = glide,
      first = LAP * Math.ceil((this.x + 0.05) / LAP)

    let best: number | null = null,
      score = Infinity

    for (let k = 0; k < 5; k++) {
      const H = first + k * LAP,
        d = H - this.x

      if (d >= stopDistance(this.v, C.tau, C.mu * 0.6)) break
      const mu = friction(this.v, C.tau, d)

      if (mu > C.mu * 12) continue
      const sc = Math.abs(Math.log(mu / C.mu))

      if (sc < score) {
        score = sc
        best = H
      }
    }

    return best
  }

  private startLap(w: number) {
    this.x += this.nudge.value
    this.v = Math.max(0, this.nudge.velocity)
    this.nudge.set(0)
    this.reservoir += glide.impulse * w
    this.phase = "lap"
    this.lapAge = 0
    this.cursorK.to(0, smooth(0.22))
  }

  private land() {
    const vIn = this.v
    this.x = 0
    this.v = 0
    this.reservoir = 0
    this.phase = "rest"
    this.home = null
    this.nudge.velocity += G.clamp(vIn * 0.6 + 0.9, 0.9, 2.2)
    this.cursorY.set(0.3)
    this.cursorY.to(0, { response: 0.36, damping: 0.55 })
    this.cursorK.to(1, { response: 0.4, damping: 0.62 })
  }

  step(dt: number) {
    this.t += dt
    const C = glide
    this.flow *= Math.exp(-dt / C.flowTau)

    if (this.phase !== "rest") {
      this.lapAge += dt

      const v0 = this.v,
        dR = this.reservoir * (1 - Math.exp(-dt / C.push))

      this.reservoir -= dR
      this.v += dR
      const base = this.phase === "lap" ? Math.min(this.v, C.cruise) : 0
      this.v = base + (this.v - base) * Math.exp(-dt / C.tau)

      if (this.phase === "lap") {
        this.v -= C.quad * this.v * this.v * dt

        if (this.v < C.cruise) this.v += (C.cruise - this.v) * (1 - Math.exp(-dt / 0.35))

        if (this.flow < C.exit && this.lapAge > 0.8) {
          this.phase = "coast"
          this.home = null
        }
      } else if (this.flow >= C.enter) this.phase = "lap"

      if (this.phase === "coast") {
        if (this.home == null) this.home = this.plan()

        if (this.home != null) {
          const H = this.home,
            d = H - this.x

          const mu = d > 1e-3 && this.v > 1e-3 ? Math.min(friction(this.v, C.tau, d), C.mu * 12) : C.mu
          this.v = Math.max(0, this.v - mu * dt)
          this.x = Math.min(H, this.x + this.v * dt)

          if (H - this.x < 0.006 || this.v < 0.03) this.land()
        } else {
          this.v = Math.max(this.v, v0)
          this.x += this.v * dt
        }
      } else this.x += this.v * dt
    }

    if (this.state === "output" && !this.reduceMotion) this.glow.to(0.3 + 0.2 * G.clamp(this.v / 20, 0, 1))
    const period = this.reduceMotion || this.state === "output" ? 0 : 1.4
    const on = period === 0 || this.phase !== "rest" || (this.t / period) % 1 < 0.55
    const target = on ? 1 : 0
    this.blink += (target - this.blink) * (1 - Math.exp(-dt / (target > this.blink ? 0.07 : 0.16)))
    this.nudge.step(dt)
    this.cursorK.step(dt)
    this.cursorY.step(dt)
    this.body.step(dt)
    this.glow.step(dt)
    this.chev.step(dt)
  }

  fill(cells: GyroCell[], dt = 1 / 60): GyroField {
    const off = this.offset
    const vel = this.phase === "rest" ? this.nudge.velocity : this.v
    const speed = Math.abs(vel)
    const comet = this.reduceMotion ? 0 : G.clamp((speed - 1) / 7, 0, 1)

    const wM = 0.3 + 0.08 * G.clamp(speed / 6, 0, 1),
      wC = 0.3

    const mk = this.chev.value,
      ck = Math.max(0, this.cursorK.value) * this.blink

    const cursor = CURSOR.map(([x, y]): P => [x, y + this.cursorY.value])
    const decay = 0.12 / (1 + speed / 4)
    const first = this.light.length !== cells.length

    if (first) this.light = cells.map(() => 0)

    const dots = cells.map((cell, i) => {
      const x = cell.column,
        y = cell.row

      let lit = 0,
        fresh = 0

      if (mk > 0.003) {
        const g = wrappedLight(CHEVRON, x, y, wM, off) * mk
        lit = combine(lit, g)
        fresh = Math.max(fresh, g * 0.6)

        if (comet > 0.01) {
          for (let j = 1; j <= 2; j++) {
            const behind = off - Math.min(1.2, vel * 0.03) * j
            lit = combine(lit, wrappedLight(CHEVRON, x, y, wM, behind) * mk * comet * Math.pow(0.4, j))
          }
        }
      }

      if (ck > 0.003) {
        const g = strokeLight(cursor, x, y, wC) * ck
        lit = combine(lit, g)
        fresh = Math.max(fresh, g * 0.55)
      }

      const P = (0.035 + 0.075 * Math.pow(cell.shade, 1.2)) * this.body.value + 0.95 * lit

      if (first || this.reduceMotion) this.light[i] = P
      const v = this.light[i]
      const nv = v + (P - v) * (1 - Math.exp(-dt / (P > v ? 0.03 : decay)))
      this.light[i] = nv

      return { light: nv, fresh: fresh * 0.4, accent: 0, size: cell.size }
    })

    return { dots, glow: this.glow.value, weights: {}, heat: 0 }
  }
}

/** Output as Poisson chunks (ShellOutputFeed), mulberry32 as the prototype. */
export class ShellOutputFeed {
  constructor(private seed = 7) {}
  static chunkRate(bytesPerSecond: number) {
    return bytesPerSecond < 1 ? 0 : Math.min(48, Math.pow(bytesPerSecond / 100, 0.68))
  }
  chunks(rate: number, dt: number) {
    if (rate <= 0 || dt <= 0) return []
    let k = 0
    const L = Math.exp(-rate * dt)
    let p = this.random()

    while (p > L && k < 12) {
      k++
      p *= this.random()
    }

    const [lo, hi] = rate < 3 ? [0.5, 1.0] : [0.6, 1.4]

    return Array.from({ length: k }, () => lo + (hi - lo) * this.random())
  }
  private random() {
    this.seed = (this.seed + 0x6d2b79f5) >>> 0
    let t = Math.imul(this.seed ^ (this.seed >>> 15), 1 | this.seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
