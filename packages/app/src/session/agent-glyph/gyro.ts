// The agent activity glyph's engine, ported from the iOS app's `ActivityGyro.swift` (itself a port of
// `prototypes/activity-glyph/gyro.js`, Kit's set). Keep it in step with the Swift: the per-state designs live in
// one table, `designs`, written as close to the Swift as TypeScript allows so tweaks copy straight over.
//
// A glyph is up to four strokes on an LED dot sphere. A stroke is the set of dots where dot(p, n) ≈ s: a great
// circle (s = 0), a smaller circle, or, seen edge-on, a straight line. Windows along it make dashes; a pitch term
// tilts it into a spiral stripe. Every design is a pose of these same numbers, so a change of state morphs the dots
// rather than cross-fading them.

export type AgentActivity =
  | "idle"
  | "startup"
  | "thinking"
  | "longWork"
  | "tool"
  | "streaming"
  | "waiting"
  | "handoff"
  | "done"
  | "failed"

export type ActivityAccent = "orange" | "red" | "green" | "blue"

export const ACCENTS: readonly ActivityAccent[] = ["orange", "red", "green", "blue"]

export const isFinal = (activity: AgentActivity) => activity === "done" || activity === "failed"

const TAU = Math.PI * 2

const HALF = Math.PI / 2

class GyroSpring {
  constructor(
    readonly response: number,
    readonly damping: number,
  ) {}

  static smooth(duration: number) {
    return new GyroSpring(duration, 1)
  }

  // Advances a damped oscillator by `t` from displacement `x0` and velocity `v0`, into `out`.
  solve(x0: number, v0: number, t: number, out: [number, number]) {
    const w = TAU / Math.max(1e-4, this.response)
    const z = this.damping

    if (z < 1) {
      const wd = w * Math.sqrt(1 - z * z)
      const e = Math.exp(-z * w * t)
      const c = Math.cos(wd * t)
      const s = Math.sin(wd * t)
      const b = (v0 + z * w * x0) / wd
      out[0] = e * (x0 * c + b * s)
      out[1] = e * (-z * w * (x0 * c + b * s) + (-x0 * wd * s + b * wd * c))

      return out
    }

    if (z === 1) {
      const e = Math.exp(-w * t)
      const b = v0 + w * x0
      out[0] = e * (x0 + b * t)
      out[1] = e * (b - w * (x0 + b * t))

      return out
    }

    const r = Math.sqrt(z * z - 1)
    const r1 = -w * (z - r)
    const r2 = -w * (z + r)
    const c1 = (v0 - r2 * x0) / (r1 - r2)
    const c2 = x0 - c1
    const e1 = Math.exp(r1 * t)
    const e2 = Math.exp(r2 * t)
    out[0] = c1 * e1 + c2 * e2
    out[1] = c1 * r1 * e1 + c2 * r2 * e2

    return out
  }
}

const scratch: [number, number] = [0, 0]

const MOVE = GyroSpring.smooth(0.6)

const SLOW = GyroSpring.smooth(1.2)

const FAST = GyroSpring.smooth(0.3)

const FADE = GyroSpring.smooth(0.45)

const RM = GyroSpring.smooth(0.35)

const W_MOVE = TAU / 0.6

const W_MIN = TAU / 1.6

const W_MAX = TAU / 0.22

// Below this angular speed (rad/s) a pose change may take the nearest equivalent, either way.
const MOVING = 0.6

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x)

const sstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1)

  return t * t * (3 - 2 * t)
}

const wrap = (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU)

const gauss = (x: number, s: number) => Math.exp(-(x * x) / (2 * s * s))

const sign = (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0)

// Latitude as an angle: S(φ) falls from 1.1 to −1.1 over each turn, so a stroke rolling past one pole comes back
// from the other.
const S = (phi: number) => 1.1 - 2.2 * (phi / TAU - Math.floor(phi / TAU))

const Sinv = (s: number) => (TAU * (1.1 - s)) / 2.2

// Strokes fade out towards the wrap at |s| = 1.1 over their own width and pitch.
const visS = (s: number, w: number, pitch: number) =>
  sstep(1.1, 1.1 - Math.min(0.6, 0.06 + 2.2 * w + 0.5 * pitch), Math.abs(s))

const ringS = (rho: number) => Math.sqrt(1 - rho * rho)

// The equivalent of x (mod period) nearest the angle's current value.
const near = (ang: GyroAngle, x: number, period = TAU) => x + period * Math.round((ang.value - x) / period)

type Vec = [number, number, number]

const dot = (a: Vec, b: Vec) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

// n, u, v for angles (θ, e, a, r): n = Rz(r)·Rx(a)·(cos e cos θ, sin e, cos e sin θ); u, v span its circle.
function frame(th: number, e: number, a: number, r: number) {
  const ce = Math.cos(e)
  const se = Math.sin(e)
  const ct = Math.cos(th)
  const st = Math.sin(th)
  const ca = Math.cos(a)
  const sa = Math.sin(a)
  const cr = Math.cos(r)
  const sr = Math.sin(r)

  const rot = (x: number, y: number, z: number): Vec => {
    const y1 = y * ca - z * sa
    const z1 = y * sa + z * ca

    return [x * cr - y1 * sr, x * sr + y1 * cr, z1]
  }

  return { n: rot(ce * ct, se, ce * st), u: rot(-st, 0, ct), v: rot(-se * ct, ce, -se * st) }
}

class GyroValue {
  value: number
  target: number
  velocity = 0

  constructor(
    value = 0,
    public config = MOVE,
    readonly precision = 0.005,
  ) {
    this.value = value
    this.target = value
  }

  to(target: number, config?: GyroSpring, immediate = false) {
    if (config) this.config = config
    this.target = target

    if (!immediate) return
    this.value = target
    this.velocity = 0
  }

  set(value: number) {
    this.value = value
    this.target = value
    this.velocity = 0
  }

  get settled() {
    return Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 10
  }

  // False once settled.
  step(dt: number) {
    if (this.settled) {
      this.value = this.target
      this.velocity = 0

      return false
    }

    const [x, v] = this.config.solve(this.value - this.target, this.velocity, dt, scratch)
    this.value = this.target + x
    this.velocity = v

    return true
  }

  clone() {
    const next = new GyroValue(this.value, this.config, this.precision)
    next.target = this.target
    next.velocity = this.velocity

    return next
  }
}

// An unwrapped angle with momentum: it either spins (its speed a spring) or holds a pose. Holding a new pose while
// moving picks the next equivalent angle ahead, far enough that a critically damped spring decelerates into it.
class GyroAngle {
  value: number
  vel = 0
  mode: "hold" | "spin" = "hold"
  anchor: number
  cfg = MOVE
  speed = new GyroValue(0, MOVE, 1e-3)
  last = { angle: 0, period: TAU }

  constructor(value = 0) {
    this.value = value
    this.anchor = value
    this.last = { angle: value, period: TAU }
  }

  set(v: number) {
    this.value = v
    this.anchor = v
    this.vel = 0
    this.mode = "hold"
    this.speed.set(0)
    this.last = { angle: v, period: TAU }
  }

  copy(o: GyroAngle) {
    this.value = o.value
    this.vel = o.vel
    this.mode = o.mode
    this.anchor = o.anchor
    this.cfg = o.cfg
    this.speed = o.speed.clone()
    this.last = { ...o.last }
  }

  // Spin at w rad/s. A spin never reverses a visible motion: against the current direction it takes w's magnitude.
  spin(input: number, cfg = MOVE, immediate = false) {
    const w = Math.abs(this.vel) > MOVING && input !== 0 && sign(input) !== sign(this.vel) ? -input : input

    if (this.mode !== "spin") {
      this.speed.set(this.vel)
      this.mode = "spin"
    }

    this.speed.to(w, cfg)

    if (!immediate) return
    this.speed.set(w)
    this.vel = w
  }

  // Come to rest on `angle` or any angle `period` away from it: moving, the first equivalent ahead by at least the
  // spring's natural stopping distance, approached by a critically damped spring that never overshoots.
  hold(angle: number, period = TAU, immediate = false, cfg?: GyroSpring, decel = true) {
    if (this.mode === "spin") this.vel = this.speed.value
    this.mode = "hold"
    this.last = { angle, period }
    const v = this.vel

    if (immediate) {
      this.anchor = angle + period * Math.round((this.value - angle) / period)
      this.value = this.anchor
      this.vel = 0

      return
    }

    if (Math.abs(v) < MOVING) {
      this.anchor = angle + period * Math.round((this.value - angle) / period)
      this.cfg = cfg ?? MOVE

      return
    }

    const dir = sign(v)
    const lead = Math.abs(v) / W_MOVE

    const k =
      dir > 0 ? Math.ceil((this.value + lead - angle) / period) : Math.floor((this.value - lead - angle) / period)

    this.anchor = angle + k * period
    const d = Math.abs(this.anchor - this.value)
    const base = cfg ? TAU / cfg.response : W_MOVE
    const w = Math.max(decel ? clamp((1.5 * Math.abs(v)) / d, W_MIN, W_MAX) : base, (1.05 * Math.abs(v)) / d)
    this.cfg = new GyroSpring(TAU / w, 1)
  }

  // Start spinning from `value` already moving at `vel`.
  launch(value: number, vel: number) {
    this.value = value
    this.vel = vel
    this.mode = "spin"
    this.speed.set(vel)
  }

  // Track a moving target as a spring.
  follow(target: number, cfg = MOVE) {
    if (this.mode === "spin") this.vel = this.speed.value
    this.mode = "hold"
    this.anchor = target
    this.cfg = cfg
  }

  get moving() {
    if (this.mode === "spin") return Math.abs(this.speed.value) > 1e-3 || !this.speed.settled

    return Math.abs(this.value - this.anchor) > 1e-4 || Math.abs(this.vel) > 1e-3
  }

  step(dt: number) {
    if (this.mode === "spin") {
      const v0 = this.speed.value
      this.speed.step(dt)
      this.value += 0.5 * (v0 + this.speed.value) * dt
      this.vel = this.speed.value

      return
    }

    const [x, v] = this.cfg.solve(this.value - this.anchor, this.vel, dt, scratch)
    this.value = this.anchor + x
    this.vel = v

    if (Math.abs(x) < 1e-4 && Math.abs(v) < 1e-3) {
      this.value = this.anchor
      this.vel = 0
    }
  }
}

const ANGLE_KEYS = ["theta", "e", "a", "r", "phi", "psi", "psiD", "psiG", "psiN", "rho"] as const

const SPRING_KEYS = ["w", "k", "pitch", "arc", "floor", "tail", "dash", "glint", "notch", "clip", "cone"] as const

type AngleKey = (typeof ANGLE_KEYS)[number]

type SpringKey = (typeof SPRING_KEYS)[number]

const NEUTRAL: Partial<Record<SpringKey, number>> = {
  w: 0.2,
  pitch: 0,
  arc: 3.6,
  floor: 0,
  tail: 0,
  dash: 0,
  glint: 0,
  notch: 0,
  clip: 2,
  cone: 0,
}

class GyroStroke {
  // SAFETY: built from every key of ANGLE_KEYS.
  angle = Object.fromEntries(ANGLE_KEYS.map((key) => [key, new GyroAngle()])) as Record<AngleKey, GyroAngle>
  // SAFETY: built from every key of SPRING_KEYS.
  spring = Object.fromEntries(SPRING_KEYS.map((key) => [key, new GyroValue(NEUTRAL[key] ?? 0, MOVE, 0.002)])) as Record<
    SpringKey,
    GyroValue
  >
  m = 11
  pitch0 = 0

  constructor() {
    this.angle.a.set(0.45)
    this.angle.phi.set(Sinv(0))
  }

  copyPose(o: GyroStroke) {
    for (const key of ANGLE_KEYS) this.angle[key].copy(o.angle[key])

    for (const key of SPRING_KEYS) {
      if (key === "k") continue
      this.spring[key].value = o.spring[key].value
      this.spring[key].velocity = o.spring[key].velocity
      this.spring[key].target = o.spring[key].target
    }

    this.m = o.m
    this.pitch0 = o.pitch0
  }

  get s() {
    return S(this.angle.phi.value)
  }

  get visible() {
    return this.spring.k.value > 0.02
  }
}

// A target for one of a stroke's angles. A spin holds `still` under reduced motion.
type GyroPose =
  | { type: "hold"; value: number; period?: number; cfg?: GyroSpring }
  | { type: "spin"; speed: number; still?: number; cfg?: GyroSpring }

const hold = (value: number, period?: number, cfg?: GyroSpring): GyroPose => ({ type: "hold", value, period, cfg })

const spin = (speed: number, still?: number, cfg?: GyroSpring): GyroPose => ({ type: "spin", speed, still, cfg })

// One stroke's retarget, like the prototype's spec objects.
type GyroSpec = {
  angles?: Partial<Record<AngleKey, GyroPose>>
  // Latitude: a hold keeps it there; a spin rolls it.
  s?: GyroPose
  springs?: Partial<Record<SpringKey, number>>
  k?: number
  m?: number
  pitch0?: number
  cfg?: GyroSpring
}

// `{ ...base, ...next }`, with `latitude` as a held `s`.
const spec = (base: GyroSpec, next: GyroSpec & { latitude?: number } = {}): GyroSpec => ({
  ...base,
  ...next,
  angles: { ...base.angles, ...next.angles },
  springs: { ...base.springs, ...next.springs },
  s: next.s ?? (next.latitude === undefined ? base.s : hold(Sinv(next.latitude))),
})

const FACE: GyroSpec = { angles: { theta: hold(HALF), e: hold(0), a: hold(0), r: hold(0) } }

const LEVEL: GyroSpec = { angles: { theta: hold(HALF), e: hold(HALF), a: hold(0), r: hold(0) } }

const MERIDIAN = (w = TAU / 1.8): GyroSpec => ({
  angles: { theta: spin(w), e: hold(0), a: hold(0.45), r: hold(0) },
  s: hold(Sinv(0)),
})

// A phosphor's time constants (seconds): light rises toward the field over `attack` and falls behind it over
// `decay`; after the state, the afterglow itself eases off over `release`.
type GyroAfterglow = { attack: number; decay: number; release?: number }

// A flash on arrival: each dot is driven hot for a short window, then cools over `decay`.
type GyroFlash = { amount: number; decay: number; spread: "all" | "ripple" | "sweep"; bloom: number }

const FLASH_START = 0.2

const FLASH_WINDOW = 0.1

const FLASH_ATTACK = 0.03

type GyroPattern = "condense" | "shimmer"

type GyroDesign = {
  id: string
  enter: (g: ActivityGyro) => void
  tick?: (g: ActivityGyro, age: number) => void
  // Where a tick settles under reduced motion.
  stillAge?: number
  afterglow?: GyroAfterglow
  pattern?: GyroPattern
  flash?: GyroFlash
}

const GLOBAL_KEYS = ["body", "flash", "glow", "ring", "comet", "orange", "red", "green", "blue"] as const

type GlobalKey = (typeof GLOBAL_KEYS)[number]

// Kit's set, one design per state.
const designs: Record<AgentActivity, GyroDesign> = {
  // Shimmer: no band, a sparse slow glitter across a dimmed orb; Done cools into it slowly.
  idle: {
    id: "shimmer",
    enter: (g) => {
      g.stroke(0, { angles: { theta: spin(0, 0.55) }, k: 0 })
      g.off(1, 2, 3)
      g.global({ body: 0.68, glow: 0.14, ring: 0 })
    },
    afterglow: { attack: 0.15, decay: 0.5 },
    pattern: "shimmer",
  },
  // Condense: dots sparkle in at random and gather onto Thinking's band, which turns underneath at Thinking's speed.
  startup: {
    id: "condense",
    enter: (g) => {
      g.stroke(0, spec(MERIDIAN(), { k: 0.02 }))
      g.off(1, 2, 3)
      g.global({ body: 0.8, glow: 0.5, ring: 0 })
    },
    tick: (g, age) => g.strokes[0]!.spring.k.to(0.95 * sstep(0.2, 1.1, age), GyroSpring.smooth(0.25)),
    stillAge: 1.4,
    afterglow: { attack: 0.05, decay: 0.35 },
    pattern: "condense",
  },
  // Comet: the band trails phosphor afterglow behind its motion.
  thinking: {
    id: "comet",
    enter: (g) => {
      g.stroke(0, spec(MERIDIAN(), { k: 0.95 }))
      g.off(1, 2, 3)
      g.global({ body: 1, glow: 0.5, ring: 0.1, comet: 1 })
    },
  },
  // Spiral churn: a three-stripe spiral turns on a tilted axis, its pitch slowly breathing.
  longWork: {
    id: "helix",
    enter: (g) => {
      for (let i = 0; i < 3; i++) {
        g.stroke(i, {
          angles: { theta: hold(HALF), e: hold(HALF), a: hold(0.4), r: hold(0.2) },
          springs: { w: 0.13, pitch: 0.5 },
          k: 0.8,
        })
      }

      g.stroke(0, { s: spin(TAU / 3, Sinv(0.2)) })
      g.off(3)
      g.global({ body: 0.9, glow: 0.55, ring: 0 })
    },
    tick: (g, age) => {
      train(g, 3, TAU / 3)

      for (let i = 0; i < 3; i++) g.strokes[i]!.spring.pitch.to(0.5 + 0.25 * Math.sin(age * 0.7), SLOW)
    },
    stillAge: 2,
  },
  // Spin kick: a turning band (tool calls would kick it faster).
  tool: {
    id: "kick",
    enter: (g) => {
      g.stroke(0, spec(MERIDIAN(), { k: 0.95 }))
      g.off(1, 2, 3)
      g.global({ body: 1, glow: 0.55, ring: 0.2 })
    },
  },
  // Spiral: tilted stripes rise out of the lower pole and into the upper.
  streaming: {
    id: "spiral",
    enter: (g) => {
      for (let i = 0; i < 3; i++) g.stroke(i, spec(LEVEL, { springs: { w: 0.12, pitch: 0.55 }, k: 0.85 }))
      g.stroke(0, { s: spin(TAU / 2.2, Sinv(0.3)) })
      g.off(3)
      g.global({ body: 0.85, glow: 0.45, ring: 0 })
    },
    tick: (g) => train(g, 3, TAU / 3),
  },
  // Rim chase: the band turns face-on and breaks into three bright clusters that chase slowly round the rim.
  waiting: {
    id: "chase",
    enter: (g) => {
      // A turning band's front arc moves left for θ increasing; the clusters peel off at the top going the same way,
      // at the band's speed, then ease down to the chase.
      const b = g.strokes[0]!
      const w = b.angle.theta.mode === "spin" ? b.angle.theta.speed.value : b.angle.theta.vel
      const dir = Math.abs(w) > MOVING ? sign(w) : -1

      if (!g.immediate && !g.reduceMotion && b.visible && b.spring.dash.value < 0.05 && Math.abs(w) > MOVING) {
        b.angle.psiD.launch(-HALF, dir * Math.min(Math.abs(w), TAU / 0.8))
      }

      g.stroke(
        0,
        spec(FACE, {
          angles: { psiD: spin((dir * TAU) / 4.5, -HALF, SLOW) },
          latitude: ringS(0.8),
          springs: { w: 0.24, dash: 0.8 },
          k: 1,
          m: 3,
        }),
      )
      g.off(1, 2, 3)
      g.global({ body: 0.9, glow: 0.45, ring: 0 })

      if (!g.immediate && !g.reduceMotion) chaseGate(g)
    },
    tick: (g) => {
      if (!g.reduceMotion) chaseGate(g)
    },
  },
  // Slide right: upright bands slide off to the right, one after another.
  handoff: {
    id: "slide",
    enter: (g) => {
      const upright = { theta: hold(Math.PI), e: hold(0), a: hold(0), r: hold(0.16) }
      g.stroke(0, { angles: upright, s: spin(TAU / 1.15, Sinv(0.2)), springs: { w: 0.17 }, k: 0.9 })
      g.stroke(1, { angles: upright, springs: { w: 0.17 }, k: 0.9 })
      g.off(2, 3)
      g.global({ body: 0.9, glow: 0.45, ring: 0 })
    },
    tick: (g) => train(g, 2, Math.PI),
  },
  // Ring: the band sweeps on, face-on, into a green ring; a flash sweeps round it.
  done: {
    id: "ring",
    enter: (g) => {
      g.stroke(0, spec(FACE, { latitude: 0.5, springs: { w: 0.2 }, k: 1 }))
      g.off(1, 2, 3)
      g.global({ body: 0.75, glow: 0.6, ring: 0 })
    },
    flash: { amount: 0.8, decay: 0.9, spread: "sweep", bloom: 0.1 },
  },
  // ×: the band levels, splits and rolls into a red ×; a soft ember flash fades slowly.
  failed: {
    id: "cross",
    enter: (g) => {
      g.stroke(
        0,
        spec(LEVEL, { angles: { r: hold(Math.PI / 4, Math.PI) }, latitude: 0, springs: { w: 0.11 }, k: 0.95 }),
      )
      g.stroke(
        1,
        spec(LEVEL, { angles: { r: hold(-Math.PI / 4, Math.PI) }, latitude: 0, springs: { w: 0.11 }, k: 0.95 }),
      )
      g.off(2, 3)
      g.global({ body: 0.8, glow: 0.45, ring: 0 })
    },
    flash: { amount: 0.6, decay: 1.2, spread: "all", bloom: 0.06 },
  },
}

const stateAccent: Partial<Record<AgentActivity, ActivityAccent>> = {
  waiting: "orange",
  failed: "red",
  done: "green",
  handoff: "blue",
}

// Rim chase entering from a band: the band lies down onto the rim, then draws in to its ring and breaks into
// clusters. Nothing sweeps through the centre.
function chaseGate(g: ActivityGyro) {
  const b = g.strokes[0]!

  // Only ever grows, so a band that must turn the long way round doesn't push the ring out and back.
  const now = sstep(
    0.55,
    0.97,
    Math.cos(wrap(b.angle.theta.value - HALF)) * Math.cos(b.angle.a.value) * Math.cos(b.angle.e.value),
  )

  const facing = g.age === 0 ? now : Math.max(g.chaseFacing ?? 0, now)
  g.chaseFacing = facing

  if (g.age === 0 || g.chaseRolls === undefined) g.chaseRolls = Math.abs(b.angle.phi.vel) > MOVING

  if (g.chaseRolls) {
    if (b.angle.phi.mode !== "hold" || g.age === 0) b.angle.phi.hold(Sinv(ringS(0.8)), TAU)
  }

  if (!g.chaseRolls) {
    if (g.age === 0) g.chaseS0 = clamp(b.s, -1, 1)
    const s0 = g.chaseS0 ?? 0
    b.angle.phi.follow(near(b.angle.phi, Sinv(s0 + (ringS(0.8) - s0) * facing)), FAST)
  }

  b.spring.dash.to(0.8 * sstep(0.4, 1, facing), FAST)
}

// Strokes 1…n−1 follow stroke 0's latitude, each `offset` further on. Trains only run forward.
function train(g: ActivityGyro, n: number, offset: number, cfg = FAST) {
  const lead = g.strokes[0]!.angle.phi.value
  const w = TAU / cfg.response

  for (let i = 1; i < n; i++) {
    const b = g.strokes[i]!.angle.phi
    const target = near(b, lead + i * offset)
    b.follow(Math.max(target, b.value + Math.max(0, b.vel) / w), cfg)
  }
}

// One dot of the orb: its place in the grid, the sphere normal under it, a top-left key light, and a size that
// shrinks towards the limb.
export type GyroCell = {
  column: number
  row: number
  normal: Vec
  shade: number
  size: number
}

function orb(n: number) {
  const half = (n - 1) / 2
  const R = n / 2 + 0.1
  const L: Vec = [-0.42, -0.52, 0.74]
  const ln = Math.hypot(...L)

  return Array.from({ length: n * n }, (_, index) => ({ column: index % n, row: Math.floor(index / n) })).flatMap(
    ({ column, row }): GyroCell[] => {
      const x = column - half
      const y = row - half

      if (Math.hypot(x, y) > n / 2) return []
      const nx = x / R
      const ny = y / R
      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
      const shade = Math.max(0, (nx * L[0] + ny * L[1] + nz * L[2]) / ln)

      return [{ column, row, normal: [nx, ny, nz], shade, size: 0.7 + 0.3 * nz }]
    },
  )
}

export const CELLS = orb(7)

// What one frame draws: per dot its light, freshness, accent and size, and the orb's glow and accent weights.
export type GyroDot = { light: number; fresh: number; accent: number; size: number }

export type GyroField = {
  dots: GyroDot[]
  glow: number
  weights: Record<ActivityAccent, number>
  // How hot the orb's hottest dot is (0…1): the renderer warms its neutral colour toward the flash's.
  heat: number
}

const hash = (i: number) => {
  const x = Math.sin(i * 12.9898 + 4.1) * 43758.5453

  return x - Math.floor(x)
}

const cellHash = (cell: GyroCell) => hash(cell.row * 7 + cell.column)

// 0.22 · s¹⁰ of a sine at 0.14–0.24 Hz with its own phase per dot.
const shimmer = (cell: GyroCell, t: number) => {
  const i = cell.row * 7 + cell.column
  const f = 0.14 + 0.1 * hash(i + 17)
  const s = 0.5 + 0.5 * Math.sin(TAU * (t * f + hash(i)))

  return 0.22 * Math.pow(s, 10)
}

const PATTERN_FADE_IN = 0.06

const PATTERN_FADE_OUT = 0.2

const patternLight = (pattern: GyroPattern, cell: GyroCell, coverage: number, t: number) => {
  if (pattern === "shimmer") return shimmer(cell, t) * sstep(0, 0.6, t)
  const phase = t * 3 + cellHash(cell)
  const sparkle = gauss(phase - Math.floor(phase) - 0.5, 0.06)

  return sparkle * (1 - sstep(0.1, 1.0, t) * (1 - coverage))
}

// The still pose under reduced motion.
const patternStill = (pattern: GyroPattern, cell: GyroCell) =>
  pattern === "shimmer" ? shimmer(cell, 2.4) : cellHash(cell) > 0.72 ? 0.8 : 0

const flashDelay = (flash: GyroFlash, cell: GyroCell) => {
  if (flash.spread === "all") return 0

  if (flash.spread === "ripple") return Math.min(1, Math.hypot(cell.normal[0], cell.normal[1])) * 0.24
  const a = Math.atan2(cell.normal[1], cell.normal[0]) + HALF

  return ((a - TAU * Math.floor(a / TAU)) / TAU) * 0.36
}

// How long each spread takes to reach its last dot.
const FLASH_SPREAD: Record<GyroFlash["spread"], number> = { all: 0, ripple: 0.24, sweep: 0.36 }

const flashDriven = (flash: GyroFlash) => FLASH_START + FLASH_WINDOW + FLASH_SPREAD[flash.spread]

// Per-dot afterglow and flash heat over the engine's field. Light follows the field through a phosphor while a
// state has an afterglow; a flash is energy in each dot that rises fast and cools over its decay, overshooting the
// light, warming the colour toward the hot one and blooming the dot. Under reduced motion there is neither.
class GyroPhosphor {
  light: number[] = []
  heat: number[] = []
  weights: Record<ActivityAccent, number> | undefined
  attack = 0
  decay = 0
  release = 0.35
  patterns = new Map<GyroPattern, { amount: number; age: number }>()
  flash: GyroFlash | undefined
  flashPending = false
  design: GyroDesign | undefined
  reduceMotion = false
  age = 0
  isSettled = true

  enter(design: GyroDesign, reduceMotion: boolean, immediate: boolean) {
    this.design = design
    this.reduceMotion = reduceMotion
    this.age = 0
    this.isSettled = false

    if (design.afterglow) {
      this.attack = design.afterglow.attack
      this.decay = design.afterglow.decay
      this.release = design.afterglow.release ?? 0.35
    }

    if (design.pattern) {
      const current = this.patterns.get(design.pattern)
      const amount = immediate || reduceMotion ? 1 : (current?.amount ?? 0)
      this.patterns.set(design.pattern, { amount, age: amount < 1e-3 ? 0 : (current?.age ?? 0) })
    }

    if (design.flash) this.flash = design.flash
    // First sight is the settled state, never an entrance.
    this.flashPending = !!design.flash && !immediate && !reduceMotion

    if (!immediate) return
    this.light = []
    this.heat = []
    this.weights = undefined

    for (const key of [...this.patterns.keys()]) if (key !== design.pattern) this.patterns.delete(key)
  }

  apply(field: GyroField, dt: number) {
    const design = this.design

    if (!design) return
    this.age += dt
    const rm = this.reduceMotion

    if (!design.afterglow) {
      const k = 1 - Math.exp(-dt / this.release)
      this.attack -= this.attack * k
      this.decay -= this.decay * k

      if (this.decay < 0.005) {
        this.attack = 0
        this.decay = 0
      }
    }

    for (const [pattern, state] of [...this.patterns]) {
      const on = pattern === design.pattern
      const target = on ? 1 : 0

      const amount = rm
        ? target
        : state.amount + (target - state.amount) * (1 - Math.exp(-dt / (on ? PATTERN_FADE_IN : PATTERN_FADE_OUT)))

      if (!on && amount < 0.002) {
        this.patterns.delete(pattern)
        continue
      }

      this.patterns.set(pattern, { amount, age: state.age + dt })
    }

    if (this.light.length !== field.dots.length) {
      this.light = field.dots.map((item) => item.light)
      this.heat = field.dots.map(() => 0)
    }

    // The accent weights fall over the afterglow's decay, never faster than the light.
    const fall = rm || this.decay < 1e-3 ? 1 : 1 - Math.exp(-dt / this.decay)
    const held = this.weights ?? field.weights
    const weights = { ...held }

    const lagWeights = ACCENTS.reduce((lag, accent) => {
      const target = field.weights[accent]
      const next = target >= held[accent] ? target : held[accent] + (target - held[accent]) * fall
      weights[accent] = next

      return Math.max(lag, next - target)
    }, 0)

    this.weights = weights
    field.weights = weights

    const tint = clamp(
      ACCENTS.reduce((sum, accent) => sum + Math.max(0, weights[accent]), 0),
      0,
      1,
    )

    const maxFresh = field.dots.reduce((max, item) => Math.max(max, item.fresh), 1e-3)
    const flashing = this.flashPending && !rm ? design.flash : undefined
    const inFlashState = !!design.flash
    let lag = lagWeights
    let hottest = 0

    CELLS.forEach((cell, i) => {
      const item = field.dots[i]

      if (!item) return
      const coverage = item.fresh / maxFresh
      let P = item.light
      let fresh = item.fresh

      for (const [pattern, state] of this.patterns) {
        if (state.amount <= 1e-3) continue
        const p = state.amount * (rm ? patternStill(pattern, cell) : patternLight(pattern, cell, coverage, state.age))
        P = Math.min(1.2, P + 0.95 * p)
        fresh = Math.max(fresh, 0.8 * p)
      }

      const v = this.light[i]!
      const tau = rm ? 0 : P > v ? this.attack : this.decay
      const next = tau < 1e-3 ? P : v + (P - v) * (1 - Math.exp(-dt / tau))
      this.light[i] = next
      lag = Math.max(lag, Math.abs(next - P))

      const x = flashing ? this.age - FLASH_START - flashDelay(flashing, cell) : -1
      const drive = flashing && x >= 0 && x < FLASH_WINDOW ? 0.15 + 0.85 * coverage : 0
      const h = this.heat[i]!
      const ht = drive > h ? FLASH_ATTACK : (this.flash?.decay ?? 1)
      const hot = rm ? 0 : h + (drive - h) * (1 - Math.exp(-dt / ht))
      this.heat[i] = hot < 1e-4 && drive === 0 ? 0 : hot
      const a = (this.flash?.amount ?? 0) * this.heat[i]!
      hottest = Math.max(hottest, a)
      item.light = next + 0.7 * a
      // Settled, a flash state's dots keep a quieter core, so the colour reads full rather than pale.
      item.fresh = inFlashState ? Math.max(fresh * (0.3 + 0.7 * a), a) : Math.max(fresh, a)
      // The accent mix follows the afterglowed light, so colour cools with it.
      item.accent = tint * sstep(0.3, 0.65, next) * (1 - a)
      item.size *= 1 + (this.flash?.bloom ?? 0) * this.heat[i]!
    })

    if (flashing && this.age >= flashDriven(flashing)) this.flashPending = false
    field.heat = hottest
    field.glow += 0.9 * hottest
    this.isSettled = rm || (!this.flashPending && hottest < 0.005 && lag < 0.002 && this.patterns.size === 0)
  }
}

export class ActivityGyro {
  op: AgentActivity
  design: GyroDesign
  readonly strokes = [0, 1, 2, 3].map(() => new GyroStroke())
  // SAFETY: built from every key of GLOBAL_KEYS.
  readonly globals = Object.fromEntries(GLOBAL_KEYS.map((key) => [key, new GyroValue(0, FADE, 0.002)])) as Record<
    GlobalKey,
    GyroValue
  >
  immediate = false
  snap = false
  age = 0
  t: number
  // Nothing will change until the next `set`.
  isStatic = false
  chaseFacing: number | undefined
  chaseRolls: boolean | undefined
  chaseS0: number | undefined
  readonly phosphor = new GyroPhosphor()

  constructor(
    op: AgentActivity = "idle",
    readonly reduceMotion = false,
    seed = 0,
  ) {
    this.op = op
    this.design = designs[op]
    this.t = seed
    this.strokes.forEach((b, i) => b.angle.theta.set(seed + i * 1.1))
    this.globals.flash.config = GyroSpring.smooth(0.32)
    this.set(op, true)
  }

  set(op: AgentActivity, immediate = false) {
    this.op = op
    this.design = designs[op]
    this.age = 0
    this.immediate = immediate
    const accents = { orange: 0, red: 0, green: 0, blue: 0 }
    const accent = stateAccent[op]

    if (accent) accents[accent] = 1
    this.global(accents)
    // Afterglow decays rather than switching off: it shrinks with the band's speed as it goes.
    this.global({ comet: 0 }, SLOW)

    for (const b of this.strokes) {
      for (const key of SPRING_KEYS) {
        const value = NEUTRAL[key]

        if (value !== undefined) b.spring[key].to(value, this.reduceMotion ? RM : MOVE, immediate)
      }
    }

    this.design.enter(this)
    this.phosphor.enter(this.design, this.reduceMotion, immediate)

    if (this.reduceMotion || immediate) this.design.tick?.(this, this.reduceMotion ? (this.design.stillAge ?? 0.5) : 0)

    if (immediate) {
      for (const b of this.strokes) {
        for (const key of ANGLE_KEYS) {
          const angle = b.angle[key]

          if (angle.mode !== "hold") continue
          angle.value = angle.anchor
          angle.vel = 0
        }

        for (const key of SPRING_KEYS) b.spring[key].set(b.spring[key].target)
      }
    }

    this.immediate = false
    this.isStatic = false
  }

  // Retargets one stroke. A hidden stroke about to show starts as a copy of stroke 0, so new strokes split off the
  // band rather than fading in.
  stroke(i: number, next: GyroSpec) {
    const b = this.strokes[i]!

    if (!b.visible && (next.k ?? 0) > 0 && !this.immediate) {
      const lead = this.strokes[0]!

      if (i > 0 && lead.visible) {
        b.copyPose(lead)
        b.spring.k.set(0)
      }

      if (i === 0 || !lead.visible) this.snap = true
    }

    const cfg = this.reduceMotion ? RM : (next.cfg ?? MOVE)
    const now = this.immediate || this.snap

    if (next.m !== undefined) b.m = next.m

    if (next.pitch0 !== undefined) b.pitch0 = next.pitch0

    for (const key of ANGLE_KEYS) {
      const pose = next.angles?.[key]

      if (pose) this.angle(b.angle[key], pose, cfg, now, i)
    }

    if (next.s) {
      // A plain hold keeps the latitude with the stroke's spring; anything else rolls it.
      if (next.s.type === "hold" && !next.s.cfg) b.angle.phi.hold(next.s.value, TAU, now, cfg)

      if (next.s.type !== "hold" || next.s.cfg) this.angle(b.angle.phi, next.s, cfg, now, i)
    }

    for (const key of SPRING_KEYS) {
      const value = next.springs?.[key]

      if (value !== undefined) b.spring[key].to(value, cfg, now)
    }

    if (next.k !== undefined) b.spring.k.to(next.k, this.reduceMotion ? RM : FADE, this.immediate)
    this.snap = false
  }

  angle(ang: GyroAngle, pose: GyroPose, cfg: GyroSpring, now: boolean, i: number) {
    if (pose.type === "spin") {
      if (this.reduceMotion) return ang.hold(pose.still ?? 0.55 + i * 0.9, TAU, now, RM)

      return ang.spin(pose.speed, pose.cfg ?? cfg, now)
    }

    ang.hold(pose.value, pose.period ?? TAU, now, pose.cfg ?? (this.reduceMotion ? RM : undefined))
  }

  // Fades strokes out while drawing them toward stroke 0, so they merge rather than vanish in place.
  off(...indices: number[]) {
    const lead = this.strokes[0]!

    for (const i of indices) {
      const b = this.strokes[i]!
      b.spring.k.to(0, this.reduceMotion ? RM : FADE, this.immediate)

      if (!b.visible || this.immediate) continue

      for (const key of ["e", "a", "r"] as const) b.angle[key].hold(lead.angle[key].anchor, TAU)

      if (lead.angle.theta.mode === "spin") b.angle.theta.spin(lead.angle.theta.speed.target)

      if (lead.angle.theta.mode !== "spin") b.angle.theta.hold(lead.angle.theta.anchor, TAU)

      // Stripes carry on the way they were going and settle onto the lead's latitude.
      if (lead.angle.phi.mode === "hold") b.angle.phi.hold(lead.angle.phi.anchor, TAU)
    }
  }

  global(values: Partial<Record<GlobalKey, number>>, cfg?: GyroSpring) {
    for (const key of GLOBAL_KEYS) {
      const value = values[key]

      if (value !== undefined) this.globals[key].to(value, this.reduceMotion ? RM : (cfg ?? FADE), this.immediate)
    }
  }

  // Advances by dt. False once nothing will change until the next `set`.
  step(dt: number) {
    if (this.isStatic) return false
    this.t += dt
    this.age += dt

    if (!this.reduceMotion) this.design.tick?.(this, this.age)
    let moving = !this.reduceMotion && !!this.design.tick

    for (const b of this.strokes) {
      const shown = b.spring.k.value > 0.003 || b.spring.k.target > 0

      for (const key of ANGLE_KEYS) {
        b.angle[key].step(dt)

        if (shown) moving = b.angle[key].moving || moving
      }

      for (const key of SPRING_KEYS) moving = b.spring[key].step(dt) || moving
    }

    for (const key of GLOBAL_KEYS) moving = this.globals[key].step(dt) || moving
    this.isStatic = !moving

    return true
  }

  fill(): GyroField {
    const comet = Math.max(0, this.globals.comet.value)

    const live = this.strokes.flatMap((b) => {
      const k = b.spring.k.value * visS(b.s, b.spring.w.value, b.spring.pitch.value)

      if (k < 0.003) return []
      const cone = b.spring.cone.value
      const a = b.angle.a.value + cone * Math.sin(b.angle.rho.value)
      const r = b.angle.r.value + cone * Math.cos(b.angle.rho.value)
      const f = frame(b.angle.theta.value, b.angle.e.value, a, r)

      const taps =
        comet > 0.01
          ? [1, 2, 3].map((j) => {
              const lag = j * 0.05

              return frame(
                b.angle.theta.value - b.angle.theta.vel * lag,
                b.angle.e.value - b.angle.e.vel * lag,
                a - b.angle.a.vel * lag,
                r - b.angle.r.vel * lag,
              ).n
            })
          : []

      return [
        {
          b,
          k,
          s: b.s,
          w: b.spring.w.value,
          ...f,
          taps,
          pitch: b.spring.pitch.value,
          arc: b.spring.arc.value,
          floor: b.spring.floor.value,
          tail: b.spring.tail.value,
          dir: sign(b.angle.psi.vel) === 0 ? -1 : sign(b.angle.psi.vel),
          dash: b.spring.dash.value,
          glint: b.spring.glint.value,
          notch: b.spring.notch.value,
          clip: b.spring.clip.value,
          psi: b.angle.psi.value,
          psiD: b.angle.psiD.value,
          psiG: b.angle.psiG.value,
          psiN: b.angle.psiN.value,
        },
      ]
    })

    const ring = this.globals.ring.value
    const flash = Math.max(0, this.globals.flash.value)
    const body = this.globals.body.value
    const ringN = ring > 1e-3 ? frame(0, HALF, this.strokes[0]!.angle.a.value, 0).n : undefined

    const accent = clamp(
      ACCENTS.reduce((sum, key) => sum + Math.max(0, this.globals[key].value), 0),
      0,
      1,
    )

    const dots = CELLS.map((cell): GyroDot => {
      const p = cell.normal
      let lit = 0
      let fresh = 0

      for (const L of live) {
        const dn = dot(p, L.n)
        const needLam = L.pitch > 1e-3 || L.arc < 3.4 || L.dash > 1e-3 || L.glint > 1e-3 || L.notch > 1e-3
        const pu = dot(p, L.u)
        const pv = dot(p, L.v)
        const lam = needLam ? Math.atan2(pv, pu) : 0
        // Angle along the stroke is undefined on its axis; windows fade out there instead of flipping.
        const on = needLam ? sstep(0.04, 0.3, Math.sqrt(pu * pu + pv * pv)) : 1
        const d = dn - L.s + (L.pitch > 1e-3 ? 0.5 * on * L.pitch * Math.cos(lam - L.b.pitch0) : 0)
        let g = gauss(d, L.w) * L.k * (0.65 + 0.35 * p[2])

        if (L.arc < 3.4) {
          const ds = wrap(lam - L.psi)
          const win = sstep(L.arc + 0.12, L.arc - 0.12, Math.abs(ds))

          const tailed =
            L.tail > 1e-3 && ds * L.dir < 0
              ? Math.max(win, L.tail * Math.exp(-Math.max(0, Math.abs(ds) - L.arc) / 0.55))
              : win

          g *= 1 - on * (1 - Math.max(L.floor, tailed))
        }

        // A few dashes are clusters a couple of dots long; many are single dots.
        if (L.dash > 1e-3) {
          g *= 1 - on * L.dash * (1 - Math.pow(0.5 + 0.5 * Math.cos(L.b.m * (lam - L.psiD)), L.b.m <= 4 ? 1.5 : 4))
        }

        if (L.glint > 1e-3) g *= 1 - on * L.glint * (1 - gauss(wrap(lam - L.psiG), 0.42))

        if (L.notch > 1e-3) g *= 1 - on * L.notch * gauss(wrap(lam - L.psiN), 0.5)

        if (L.clip < 1.5) g *= sstep(0.12, -0.12, p[0] - L.clip)

        L.taps.forEach((tap, j) => {
          g = Math.max(g, gauss(dot(p, tap) - L.s, L.w) * L.k * comet * Math.pow(0.5, j + 1) * 0.9)
        })
        lit = 1 - (1 - lit) * (1 - Math.min(1, g))
        fresh = Math.max(fresh, g)
      }

      const ringLight = ringN ? ring * Math.exp(-(dot(p, ringN) ** 2) / 0.045) : 0

      const P =
        (0.14 + 0.4 * Math.pow(cell.shade, 1.2)) * body + 0.95 * lit + ringLight + flash * (0.25 + 0.45 * cell.shade)

      return { light: P, fresh: fresh * 0.8, accent: accent * sstep(0.3, 0.65, P), size: cell.size }
    })

    return {
      dots,
      glow: this.globals.glow.value + 0.6 * flash,
      weights: {
        orange: Math.max(0, this.globals.orange.value),
        red: Math.max(0, this.globals.red.value),
        green: Math.max(0, this.globals.green.value),
        blue: Math.max(0, this.globals.blue.value),
      },
      heat: 0,
    }
  }

  // The field as drawn: the engine's, through the afterglow and flash, `dt` after the last frame.
  render(dt: number) {
    const field = this.fill()
    this.phosphor.apply(field, dt)

    return field
  }

  // Nothing moves or cools until the next state.
  get isResting() {
    return this.isStatic && this.phosphor.isSettled
  }
}
