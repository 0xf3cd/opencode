// The iOS app's activity glyph engine, ported from opencode-ios
// OpenCode/AgentActivity/ActivityGyro.swift. Names follow the Swift so tweaks copy
// straight over. A glyph is up to four strokes on a 7 × 7 LED dot sphere; each state
// is a pose of the same numbers, so a change of state morphs the dots instead of
// cross-fading them, and angles never double back.

export type Activity =
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

export const isFinal = (a: Activity) => a === "done" || a === "failed"

export type Accent = "orange" | "red" | "green" | "blue"

export const ACCENTS: Accent[] = ["orange", "red", "green", "blue"]

// MARK: Springs

export interface GyroSpring {
  response: number
  damping: number
}

export const smooth = (d: number): GyroSpring => ({ response: d, damping: 1 })

export function solve(cfg: GyroSpring, x0: number, v0: number, t: number): [number, number] {
  const w = (2 * Math.PI) / Math.max(1e-4, cfg.response)
  const z = cfg.damping

  if (z < 1) {
    const wd = w * Math.sqrt(1 - z * z)

    const e = Math.exp(-z * w * t),
      c = Math.cos(wd * t),
      s = Math.sin(wd * t)

    const b = (v0 + z * w * x0) / wd

    return [e * (x0 * c + b * s), e * (-z * w * (x0 * c + b * s) + (-x0 * wd * s + b * wd * c))]
  }

  if (z === 1) {
    const e = Math.exp(-w * t),
      b = v0 + w * x0

    return [e * (x0 + b * t), e * (b - w * (x0 + b * t))]
  }

  const r = Math.sqrt(z * z - 1)

  const r1 = -w * (z - r),
    r2 = -w * (z + r)

  const c1 = (v0 - r2 * x0) / (r1 - r2),
    c2 = x0 - c1

  const e1 = Math.exp(r1 * t),
    e2 = Math.exp(r2 * t)

  return [c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2]
}

/** The app's springs (`Gyro.MOVE`, `.SLOW`, …): duration, bounce 0. */
export const tune = {
  MOVE: smooth(0.6),
  SLOW: smooth(1.2),
  FAST: smooth(0.3),
  FADE: smooth(0.45),
  RM: smooth(0.35),
  FLASH: smooth(0.32),
}

export class GyroValue {
  value: number
  target: number
  velocity = 0
  config: GyroSpring
  precision: number
  constructor(value = 0, config: GyroSpring = tune.MOVE, precision = 0.005) {
    this.value = value
    this.target = value
    this.config = config
    this.precision = precision
  }
  clone() {
    const v = new GyroValue(this.value, this.config, this.precision)
    v.target = this.target
    v.velocity = this.velocity

    return v
  }
  to(target: number, config?: GyroSpring | null, immediate = false) {
    if (config) this.config = config
    this.target = target

    if (immediate) {
      this.value = target
      this.velocity = 0
    }
  }
  set(value: number) {
    this.value = value
    this.target = value
    this.velocity = 0
  }
  get settled() {
    return Math.abs(this.value - this.target) < this.precision && Math.abs(this.velocity) < this.precision * 10
  }
  step(dt: number) {
    if (this.settled) {
      this.value = this.target
      this.velocity = 0

      return false
    }

    const [x, v] = solve(this.config, this.value - this.target, this.velocity, dt)
    this.value = this.target + x
    this.velocity = v

    return true
  }
}

// MARK: Constants and helpers

const TAU = Math.PI * 2

const HALF = Math.PI / 2

const W_MOVE = () => TAU / tune.MOVE.response

const W_MIN = TAU / 1.6,
  W_MAX = TAU / 0.22

const MOVING = 0.6

export const G = {
  TAU,
  HALF,
  clamp: (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x),
  sstep(a: number, b: number, x: number) {
    const t = G.clamp((x - a) / (b - a), 0, 1)

    return t * t * (3 - 2 * t)
  },
  wrap: (a: number) => a - TAU * Math.floor((a + Math.PI) / TAU),
  gauss: (x: number, s: number) => Math.exp(-(x * x) / (2 * s * s)),
  sign: (x: number) => (x > 0 ? 1 : x < 0 ? -1 : 0),
  S: (phi: number) => 1.1 - 2.2 * (phi / TAU - Math.floor(phi / TAU)),
  Sinv: (s: number) => (TAU * (1.1 - s)) / 2.2,
  visS(s: number, w: number, pitch: number) {
    const fw = Math.min(0.6, 0.06 + 2.2 * w + 0.5 * pitch)

    return G.sstep(1.1, 1.1 - fw, Math.abs(s))
  },
  ringS: (rho: number) => Math.sqrt(1 - rho * rho),
  near: (ang: GyroAngle, x: number, period = TAU) => x + period * swiftRound((ang.value - x) / period),
  frame(th: number, e: number, a: number, r: number) {
    const ce = Math.cos(e),
      se = Math.sin(e),
      ct = Math.cos(th),
      st = Math.sin(th)

    const ca = Math.cos(a),
      sa = Math.sin(a),
      cr = Math.cos(r),
      sr = Math.sin(r)

    const rot = (x: number, y: number, z: number): V3 => {
      const y1 = y * ca - z * sa,
        z1 = y * sa + z * ca

      return [x * cr - y1 * sr, x * sr + y1 * cr, z1]
    }

    return { n: rot(ce * ct, se, ce * st), u: rot(-st, 0, ct), v: rot(-se * ct, ce, -se * st) }
  },
}

type V3 = [number, number, number]

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Swift's `.rounded()`: half away from zero. */
function swiftRound(x: number) {
  return x < 0 ? -Math.round(-x) : Math.round(x)
}

// MARK: Unwrapped angle with momentum

export class GyroAngle {
  value: number
  vel = 0
  mode: "hold" | "spin" = "hold"
  anchor: number
  cfg = tune.MOVE
  speed = new GyroValue(0, tune.MOVE, 1e-3)
  last: { angle: number; period: number }

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

  spin(w: number, cfg: GyroSpring = tune.MOVE, immediate = false) {
    if (Math.abs(this.vel) > MOVING && w !== 0 && G.sign(w) !== G.sign(this.vel)) w = -w

    if (this.mode !== "spin") {
      this.speed.set(this.vel)
      this.mode = "spin"
    }

    this.speed.to(w, cfg)

    if (immediate) {
      this.speed.set(w)
      this.vel = w
    }
  }

  hold(angle: number, period = TAU, immediate = false, cfg: GyroSpring | null = null, decel = true) {
    if (this.mode === "spin") this.vel = this.speed.value
    this.mode = "hold"
    this.last = { angle, period }
    const v = this.vel

    if (immediate) {
      this.anchor = angle + period * swiftRound((this.value - angle) / period)
      this.value = this.anchor
      this.vel = 0

      return
    }

    if (Math.abs(v) < MOVING) {
      this.anchor = angle + period * swiftRound((this.value - angle) / period)
      this.cfg = cfg ?? tune.MOVE

      return
    }

    const dir = G.sign(v),
      lead = Math.abs(v) / W_MOVE()

    const k =
      dir > 0 ? Math.ceil((this.value + lead - angle) / period) : Math.floor((this.value - lead - angle) / period)

    this.anchor = angle + k * period
    const d = Math.abs(this.anchor - this.value)
    let w = cfg ? TAU / cfg.response : W_MOVE()

    if (decel) w = G.clamp((1.5 * Math.abs(v)) / d, W_MIN, W_MAX)
    w = Math.max(w, (1.05 * Math.abs(v)) / d)
    this.cfg = { response: TAU / w, damping: 1 }
  }

  launch(value: number, vel: number) {
    this.value = value
    this.vel = vel
    this.mode = "spin"
    this.speed.set(vel)
  }

  follow(target: number, cfg: GyroSpring = tune.MOVE) {
    if (this.mode === "spin") this.vel = this.speed.value
    this.mode = "hold"
    this.anchor = target
    this.cfg = cfg
  }

  kick(d: number, cfg: GyroSpring | null = null) {
    if (this.mode === "spin") {
      const w = TAU / this.speed.config.response
      this.speed.velocity += d * w * w

      return
    }

    this.vel = G.sign(d) * Math.max(Math.abs(this.vel), MOVING + 0.1)
    this.hold(this.last.angle, this.last.period, false, cfg, cfg == null)
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

    const [x, v] = solve(this.cfg, this.value - this.anchor, this.vel, dt)
    this.value = this.anchor + x
    this.vel = v

    if (Math.abs(x) < 1e-4 && Math.abs(v) < 1e-3) {
      this.value = this.anchor
      this.vel = 0
    }
  }
}

// MARK: Strokes

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

function record<K extends string, V>(keys: readonly K[], value: (key: K) => V) {
  // SAFETY: the entries cover every key in `keys`, so the object has exactly the keys of K.
  return Object.fromEntries(keys.map((key) => [key, value(key)])) as Record<K, V>
}

export class GyroStroke {
  ang = record(ANGLE_KEYS, () => new GyroAngle())
  sp = record(SPRING_KEYS, (k) => new GyroValue(NEUTRAL[k] ?? 0, tune.MOVE, 0.002))
  m = 11
  pitch0 = 0
  constructor() {
    this.ang.a.set(0.45)
    this.ang.phi.set(G.Sinv(0))
  }
  copyPose(o: GyroStroke) {
    for (const k of ANGLE_KEYS) this.ang[k].copy(o.ang[k])

    for (const k of SPRING_KEYS) {
      if (k === "k") continue
      this.sp[k].value = o.sp[k].value
      this.sp[k].velocity = o.sp[k].velocity
      this.sp[k].target = o.sp[k].target
    }

    this.m = o.m
    this.pitch0 = o.pitch0
  }
  get s() {
    return G.S(this.ang.phi.value)
  }
  get visible() {
    return this.sp.k.value > 0.02
  }
}

type Pose = { hold: number; period?: number; cfg?: GyroSpring } | { spin: number; still?: number; cfg?: GyroSpring }

interface Spec {
  angles?: Partial<Record<AngleKey, Pose>>
  s?: Pose
  springs?: Partial<Record<SpringKey, number>>
  k?: number
  m?: number
  pitch0?: number
  cfg?: GyroSpring
}

const FACE: Spec = { angles: { theta: { hold: HALF }, e: { hold: 0 }, a: { hold: 0 }, r: { hold: 0 } } }

const LEVEL: Spec = { angles: { theta: { hold: HALF }, e: { hold: HALF }, a: { hold: 0 }, r: { hold: 0 } } }

const MERIDIAN = (w = TAU / 1.8): Spec => ({
  angles: { theta: { spin: w }, e: { hold: 0 }, a: { hold: 0.45 }, r: { hold: 0 } },
  s: { hold: G.Sinv(0) },
})

function withSpec(base: Spec, o: Spec & { latitude?: number }): Spec {
  const spec: Spec = { ...base, angles: { ...base.angles, ...o.angles }, springs: { ...base.springs, ...o.springs } }

  if (o.latitude !== undefined) spec.s = { hold: G.Sinv(o.latitude) }

  if (o.s) spec.s = o.s

  if (o.k !== undefined) spec.k = o.k

  if (o.m !== undefined) spec.m = o.m

  if (o.pitch0 !== undefined) spec.pitch0 = o.pitch0

  if (o.cfg) spec.cfg = o.cfg

  return spec
}

// MARK: Designs

interface Afterglow {
  attack: number
  decay: number
  release: number
}

type Pattern = "condense" | "shimmer"

interface Flash {
  amount: number
  decay: number
  spread: "all" | "ripple" | "sweep"
  bloom: number
}

interface Design {
  id: string
  enter: (g: ActivityGyro) => void
  tick?: (g: ActivityGyro, age: number) => void
  onTool?: (g: ActivityGyro) => void
  onOutput?: (g: ActivityGyro) => void
  stillAge?: number
  afterglow?: Afterglow
  pattern?: Pattern
  flash?: Flash
}

export const DESIGNS: Record<Activity, Design> = {
  idle: {
    id: "shimmer",
    enter(g) {
      g.stroke(0, { angles: { theta: { spin: 0, still: 0.55 } }, k: 0 })
      g.off(1, 2, 3)
      g.global({ body: 0.68, glow: 0.14, ring: 0 })
    },
    afterglow: { attack: 0.15, decay: 0.5, release: 0.35 },
    pattern: "shimmer",
  },
  startup: {
    id: "condense",
    enter(g) {
      g.stroke(0, withSpec(MERIDIAN(), { k: 0.02 }))
      g.off(1, 2, 3)
      g.global({ body: 0.8, glow: 0.5, ring: 0 })
    },
    tick(g, age) {
      g.strokes[0].sp.k.to(0.95 * G.sstep(0.2, 1.1, age), smooth(0.25))
    },
    stillAge: 1.4,
    afterglow: { attack: 0.05, decay: 0.35, release: 0.35 },
    pattern: "condense",
  },
  thinking: {
    id: "comet",
    enter(g) {
      g.stroke(0, withSpec(MERIDIAN(), { k: 0.95 }))
      g.off(1, 2, 3)
      g.global({ body: 1, glow: 0.5, ring: 0.1, comet: 1 })
    },
  },
  longWork: {
    id: "helix",
    enter(g) {
      for (let i = 0; i < 3; i++) {
        g.stroke(i, {
          angles: { theta: { hold: HALF }, e: { hold: HALF }, a: { hold: 0.4 }, r: { hold: 0.2 } },
          springs: { w: 0.13, pitch: 0.5 },
          k: 0.8,
        })
      }

      g.stroke(0, { s: { spin: TAU / 3, still: G.Sinv(0.2) } })
      g.off(3)
      g.global({ body: 0.9, glow: 0.55, ring: 0 })
    },
    tick(g, age) {
      train(g, 3, TAU / 3)

      for (let i = 0; i < 3; i++) g.strokes[i].sp.pitch.to(0.5 + 0.25 * Math.sin(age * 0.7), tune.SLOW)
    },
    stillAge: 2,
  },
  tool: {
    id: "kick",
    enter(g) {
      g.stroke(0, withSpec(MERIDIAN(), { k: 0.95 }))
      g.off(1, 2, 3)
      g.global({ body: 1, glow: 0.55, ring: 0.2 })
    },
    onTool(g) {
      g.strokes[0].ang.theta.kick(TAU * 0.45)
      g.impulse("flash", 0.08)
    },
  },
  streaming: {
    id: "spiral",
    enter(g) {
      for (let i = 0; i < 3; i++) g.stroke(i, withSpec(LEVEL, { springs: { w: 0.12, pitch: 0.55 }, k: 0.85 }))
      g.stroke(0, { s: { spin: TAU / 2.2, still: G.Sinv(0.3) } })
      g.off(3)
      g.global({ body: 0.85, glow: 0.45, ring: 0 })
    },
    tick(g) {
      train(g, 3, TAU / 3)
    },
    onOutput(g) {
      g.strokes[0].ang.phi.kick(0.35)
    },
  },
  waiting: {
    id: "chase",
    enter(g) {
      const b = g.strokes[0],
        w = b.ang.theta.mode === "spin" ? b.ang.theta.speed.value : b.ang.theta.vel

      const dir = Math.abs(w) > MOVING ? G.sign(w) : -1

      if (!g.immediate && !g.reduceMotion && b.visible && b.sp.dash.value < 0.05 && Math.abs(w) > MOVING) {
        b.ang.psiD.launch(-HALF, dir * Math.min(Math.abs(w), TAU / 0.8))
      }

      g.stroke(
        0,
        withSpec(FACE, {
          angles: { psiD: { spin: (dir * TAU) / 4.5, still: -HALF, cfg: tune.SLOW } },
          latitude: G.ringS(0.8),
          springs: { w: 0.24, dash: 0.8 },
          k: 1,
          m: 3,
        }),
      )
      g.off(1, 2, 3)
      g.global({ body: 0.9, glow: 0.45, ring: 0 })

      if (!g.immediate && !g.reduceMotion) chaseGate(g)
    },
    tick(g) {
      if (!g.reduceMotion) chaseGate(g)
    },
  },
  handoff: {
    id: "slide",
    enter(g) {
      const upright: Spec["angles"] = { theta: { hold: Math.PI }, e: { hold: 0 }, a: { hold: 0 }, r: { hold: 0.16 } }
      g.stroke(0, { angles: upright, s: { spin: TAU / 1.15, still: G.Sinv(0.2) }, springs: { w: 0.17 }, k: 0.9 })
      g.stroke(1, { angles: upright, springs: { w: 0.17 }, k: 0.9 })
      g.off(2, 3)
      g.global({ body: 0.9, glow: 0.45, ring: 0 })
    },
    tick(g) {
      train(g, 2, Math.PI)
    },
  },
  done: {
    id: "ring",
    enter(g) {
      g.stroke(0, withSpec(FACE, { latitude: 0.5, springs: { w: 0.2 }, k: 1 }))
      g.off(1, 2, 3)
      g.global({ body: 0.75, glow: 0.6, ring: 0 })
    },
    flash: { amount: 0.8, decay: 0.9, spread: "sweep", bloom: 0.1 },
  },
  failed: {
    id: "cross",
    enter(g) {
      g.stroke(
        0,
        withSpec(LEVEL, {
          angles: { r: { hold: Math.PI / 4, period: Math.PI } },
          latitude: 0,
          springs: { w: 0.11 },
          k: 0.95,
        }),
      )
      g.stroke(
        1,
        withSpec(LEVEL, {
          angles: { r: { hold: -Math.PI / 4, period: Math.PI } },
          latitude: 0,
          springs: { w: 0.11 },
          k: 0.95,
        }),
      )
      g.off(2, 3)
      g.global({ body: 0.8, glow: 0.45, ring: 0 })
    },
    flash: { amount: 0.6, decay: 1.2, spread: "all", bloom: 0.06 },
  },
}

const STATE_ACCENT: Partial<Record<Activity, Accent>> = {
  waiting: "orange",
  failed: "red",
  done: "green",
  handoff: "blue",
}

function chaseGate(g: ActivityGyro) {
  const b = g.strokes[0]

  const now = G.sstep(
    0.55,
    0.97,
    Math.cos(G.wrap(b.ang.theta.value - HALF)) * Math.cos(b.ang.a.value) * Math.cos(b.ang.e.value),
  )

  const facing = g.age === 0 ? now : Math.max(g.chaseFacing ?? 0, now)
  g.chaseFacing = facing

  if (g.age === 0 || g.chaseRolls == null) g.chaseRolls = Math.abs(b.ang.phi.vel) > MOVING

  if (g.chaseRolls) {
    if (b.ang.phi.mode !== "hold" || g.age === 0) b.ang.phi.hold(G.Sinv(G.ringS(0.8)), TAU)
  } else {
    if (g.age === 0) g.chaseS0 = G.clamp(b.s, -1, 1)
    const s0 = g.chaseS0 ?? 0
    b.ang.phi.follow(G.near(b.ang.phi, G.Sinv(s0 + (G.ringS(0.8) - s0) * facing)), tune.FAST)
  }

  b.sp.dash.to(0.8 * G.sstep(0.4, 1, facing), tune.FAST)
}

function train(g: ActivityGyro, n: number, offset: number, cfg: GyroSpring = tune.FAST) {
  const lead = g.strokes[0].ang.phi.value,
    w = TAU / cfg.response

  for (let i = 1; i < n; i++) {
    const b = g.strokes[i].ang.phi
    const target = G.near(b, lead + i * offset)
    b.follow(Math.max(target, b.value + Math.max(0, b.vel) / w), cfg)
  }
}

// MARK: The glyph

const GLOBAL_KEYS = ["body", "flash", "glow", "ring", "comet", "orange", "red", "green", "blue"] as const

type GlobalKey = (typeof GLOBAL_KEYS)[number]

export class ActivityGyro {
  op: Activity
  design: Design
  strokes = [0, 1, 2, 3].map(() => new GyroStroke())
  gl = record(GLOBAL_KEYS, () => new GyroValue(0, tune.FADE, 0.002))
  reduceMotion: boolean
  immediate = false
  private snap = false
  age = 0
  private t: number
  isStatic = false
  chaseFacing: number | null = null
  chaseRolls: boolean | null = null
  chaseS0: number | null = null
  phosphor = new GyroPhosphor()

  constructor(op: Activity = "idle", reduceMotion = false, seed = 0) {
    this.op = op
    this.design = DESIGNS[op]
    this.reduceMotion = reduceMotion
    this.t = seed
    this.strokes.forEach((b, i) => b.ang.theta.set(seed + i * 1.1))
    this.gl.flash.config = tune.FLASH
    this.set(op, true)
  }

  set(op: Activity, immediate = false) {
    this.op = op
    this.design = DESIGNS[op]
    this.age = 0
    this.immediate = immediate

    for (const a of ACCENTS) this.global({ [a]: STATE_ACCENT[op] === a ? 1 : 0 })
    this.global({ comet: 0 }, tune.SLOW)

    for (const b of this.strokes) {
      for (const key of SPRING_KEYS) {
        const value = NEUTRAL[key]

        if (value !== undefined) b.sp[key].to(value, this.reduceMotion ? tune.RM : tune.MOVE, immediate)
      }
    }

    this.design.enter(this)
    this.phosphor.enter(this.design, this.reduceMotion, immediate)

    if (this.reduceMotion || immediate) this.design.tick?.(this, this.reduceMotion ? (this.design.stillAge ?? 0.5) : 0)

    if (immediate) {
      for (const b of this.strokes) {
        for (const k of ANGLE_KEYS) {
          const a = b.ang[k]

          if (a.mode === "hold") {
            a.value = a.anchor
            a.vel = 0
          }
        }

        for (const k of SPRING_KEYS) b.sp[k].set(b.sp[k].target)
      }
    }

    this.immediate = false
    this.isStatic = false
  }

  stroke(i: number, spec: Spec) {
    const b = this.strokes[i]

    if (!b.visible && (spec.k ?? 0) > 0 && !this.immediate) {
      const lead = this.strokes[0]

      if (i > 0 && lead.visible) {
        b.copyPose(lead)
        b.sp.k.set(0)
      } else this.snap = true
    }

    const cfg = this.reduceMotion ? tune.RM : (spec.cfg ?? tune.MOVE)
    const now = this.immediate || this.snap

    if (spec.m !== undefined) b.m = spec.m

    if (spec.pitch0 !== undefined) b.pitch0 = spec.pitch0

    for (const key of ANGLE_KEYS) {
      const pose = spec.angles?.[key]

      if (pose) this.angle(b.ang[key], pose, cfg, now, i)
    }

    if (spec.s) {
      const s = spec.s

      if ("hold" in s && !s.cfg) b.ang.phi.hold(s.hold, TAU, now, cfg)
      else this.angle(b.ang.phi, s, cfg, now, i)
    }

    for (const key of SPRING_KEYS) {
      const value = spec.springs?.[key]

      if (value !== undefined) b.sp[key].to(value, cfg, now)
    }

    if (spec.k !== undefined) b.sp.k.to(spec.k, this.reduceMotion ? tune.RM : tune.FADE, this.immediate)
    this.snap = false
  }

  private angle(ang: GyroAngle, pose: Pose, cfg: GyroSpring, now: boolean, i: number) {
    if ("spin" in pose) {
      if (this.reduceMotion) ang.hold(pose.still ?? 0.55 + i * 0.9, TAU, now, tune.RM)
      else ang.spin(pose.spin, pose.cfg ?? cfg, now)

      return
    }

    ang.hold(pose.hold, pose.period ?? TAU, now, pose.cfg ?? (this.reduceMotion ? tune.RM : null))
  }

  off(...indices: number[]) {
    const lead = this.strokes[0]

    for (const i of indices) {
      const b = this.strokes[i]
      b.sp.k.to(0, this.reduceMotion ? tune.RM : tune.FADE, this.immediate)

      if (!b.visible || this.immediate) continue

      for (const key of ["e", "a", "r"] as const) b.ang[key].hold(lead.ang[key].anchor, TAU)

      if (lead.ang.theta.mode === "spin") b.ang.theta.spin(lead.ang.theta.speed.target)
      else b.ang.theta.hold(lead.ang.theta.anchor, TAU)

      if (lead.ang.phi.mode === "hold") b.ang.phi.hold(lead.ang.phi.anchor, TAU)
    }
  }

  global(values: Partial<Record<GlobalKey, number>>, cfg?: GyroSpring) {
    for (const key of GLOBAL_KEYS) {
      const value = values[key]

      if (value !== undefined) this.gl[key].to(value, this.reduceMotion ? tune.RM : (cfg ?? tune.FADE), this.immediate)
    }
  }

  impulse(key: GlobalKey, peak: number) {
    if (this.reduceMotion || this.immediate) return
    const w = TAU / this.gl[key].config.response
    this.gl[key].velocity += peak * Math.E * w
  }

  event(kind: "tool" | "output") {
    if (this.reduceMotion) return
    this.isStatic = false

    if (kind === "tool") this.design.onTool?.(this)
    else this.design.onOutput?.(this)
  }

  step(dt: number) {
    if (this.isStatic) return false
    this.t += dt
    this.age += dt

    if (!this.reduceMotion) this.design.tick?.(this, this.age)
    let moving = !this.reduceMotion && this.design.tick != null

    for (const b of this.strokes) {
      for (const k of ANGLE_KEYS) {
        const angle = b.ang[k]
        angle.step(dt)

        if (b.sp.k.value > 0.003 || b.sp.k.target > 0) moving = angle.moving || moving
      }

      for (const k of SPRING_KEYS) moving = b.sp[k].step(dt) || moving
    }

    for (const k of GLOBAL_KEYS) moving = this.gl[k].step(dt) || moving
    this.isStatic = !moving

    return true
  }

  fill(cells: GyroCell[]): GyroField {
    const comet = Math.max(0, this.gl.comet.value)

    const live: {
      b: GyroStroke
      k: number
      s: number
      w: number
      n: V3
      u: V3
      v: V3
      taps: V3[]
      pitch: number
      arc: number
      floor: number
      tail: number
      dir: number
      dash: number
      glint: number
      notch: number
      clip: number
      psi: number
      psiD: number
      psiG: number
      psiN: number
    }[] = []

    for (const b of this.strokes) {
      const k = b.sp.k.value * G.visS(b.s, b.sp.w.value, b.sp.pitch.value)

      if (k < 0.003) continue
      const cone = b.sp.cone.value

      const a = b.ang.a.value + cone * Math.sin(b.ang.rho.value),
        r = b.ang.r.value + cone * Math.cos(b.ang.rho.value)

      const f = G.frame(b.ang.theta.value, b.ang.e.value, a, r)
      const taps: V3[] = []

      if (comet > 0.01) {
        for (let j = 1; j <= 3; j++) {
          const lag = j * 0.05
          taps.push(
            G.frame(
              b.ang.theta.value - b.ang.theta.vel * lag,
              b.ang.e.value - b.ang.e.vel * lag,
              a - b.ang.a.vel * lag,
              r - b.ang.r.vel * lag,
            ).n,
          )
        }
      }

      live.push({
        b,
        k,
        s: b.s,
        w: b.sp.w.value,
        n: f.n,
        u: f.u,
        v: f.v,
        taps,
        pitch: b.sp.pitch.value,
        arc: b.sp.arc.value,
        floor: b.sp.floor.value,
        tail: b.sp.tail.value,
        dir: G.sign(b.ang.psi.vel) === 0 ? -1 : G.sign(b.ang.psi.vel),
        dash: b.sp.dash.value,
        glint: b.sp.glint.value,
        notch: b.sp.notch.value,
        clip: b.sp.clip.value,
        psi: b.ang.psi.value,
        psiD: b.ang.psiD.value,
        psiG: b.ang.psiG.value,
        psiN: b.ang.psiN.value,
      })
    }

    const ring = this.gl.ring.value,
      flash = Math.max(0, this.gl.flash.value),
      body = this.gl.body.value

    const ringN: V3 = ring > 1e-3 ? G.frame(0, HALF, this.strokes[0].ang.a.value, 0).n : [0, 0, 0]

    const accent = G.clamp(
      ACCENTS.reduce((s, c) => s + Math.max(0, this.gl[c].value), 0),
      0,
      1,
    )

    const dots: GyroField["dots"] = []

    for (const cell of cells) {
      const p: V3 = [cell.nx, cell.ny, cell.nz]
      const shade = cell.shade

      let lit = 0,
        fresh = 0

      for (const L of live) {
        const dn = dot3(p, L.n)
        const needLam = L.pitch > 1e-3 || L.arc < 3.4 || L.dash > 1e-3 || L.glint > 1e-3 || L.notch > 1e-3

        const pu = dot3(p, L.u),
          pv = dot3(p, L.v)

        const lam = needLam ? Math.atan2(pv, pu) : 0
        const on = needLam ? G.sstep(0.04, 0.3, Math.sqrt(pu * pu + pv * pv)) : 1
        const d = dn - L.s + (L.pitch > 1e-3 ? 0.5 * on * L.pitch * Math.cos(lam - L.b.pitch0) : 0)
        let g = G.gauss(d, L.w) * L.k * (0.65 + 0.35 * cell.nz)

        if (L.arc < 3.4) {
          const ds = G.wrap(lam - L.psi)
          let win = G.sstep(L.arc + 0.12, L.arc - 0.12, Math.abs(ds))

          if (L.tail > 1e-3 && ds * L.dir < 0)
            win = Math.max(win, L.tail * Math.exp(-Math.max(0, Math.abs(ds) - L.arc) / 0.55))
          g *= 1 - on * (1 - Math.max(L.floor, win))
        }

        if (L.dash > 1e-3) {
          g *= 1 - on * L.dash * (1 - Math.pow(0.5 + 0.5 * Math.cos(L.b.m * (lam - L.psiD)), L.b.m <= 4 ? 1.5 : 4))
        }

        if (L.glint > 1e-3) g *= 1 - on * L.glint * (1 - G.gauss(G.wrap(lam - L.psiG), 0.42))

        if (L.notch > 1e-3) g *= 1 - on * L.notch * G.gauss(G.wrap(lam - L.psiN), 0.5)

        if (L.clip < 1.5) g *= G.sstep(0.12, -0.12, cell.nx - L.clip)
        L.taps.forEach((tap, j) => {
          const dt = dot3(p, tap) - L.s
          g = Math.max(g, G.gauss(dt, L.w) * L.k * comet * Math.pow(0.5, j + 1) * 0.9)
        })
        lit = 1 - (1 - lit) * (1 - Math.min(1, g))
        fresh = Math.max(fresh, g)
      }

      let extra = 0

      if (ring > 1e-3) {
        const d = dot3(p, ringN)
        extra += ring * Math.exp((-d * d) / 0.045)
      }

      const P = (0.14 + 0.4 * Math.pow(shade, 1.2)) * body + 0.95 * lit + extra + flash * (0.25 + 0.45 * shade)
      dots.push({ light: P, fresh: fresh * 0.8, accent: accent * G.sstep(0.3, 0.65, P), size: cell.size })
    }

    const weights = record(ACCENTS, (a) => Math.max(0, this.gl[a].value))

    return { dots, glow: this.gl.glow.value + 0.6 * flash, weights, heat: 0 }
  }

  render(cells: GyroCell[], dt: number) {
    const field = this.fill(cells)
    this.phosphor.apply(field, cells, dt)

    return field
  }

  get isResting() {
    return this.isStatic && this.phosphor.isSettled
  }
}

// MARK: The LED field

export interface GyroCell {
  column: number
  row: number
  nx: number
  ny: number
  nz: number
  shade: number
  size: number
}

export interface GyroField {
  dots: { light: number; fresh: number; accent: number; size: number }[]
  glow: number
  weights: Partial<Record<Accent, number>>
  heat: number
}

const KEY: V3 = [-0.42, -0.52, 0.74]

const KEY_LEN = Math.hypot(...KEY)

function shadeFor(nx: number, ny: number, nz: number) {
  return Math.max(0, (nx * KEY[0] + ny * KEY[1] + nz * KEY[2]) / KEY_LEN)
}

export function orbCells(n: number): GyroCell[] {
  const half = (n - 1) / 2,
    R = n / 2 + 0.1

  const cells: GyroCell[] = []

  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      const x = column - half,
        y = row - half

      if (Math.sqrt(x * x + y * y) > n / 2) continue

      const nx = x / R,
        ny = y / R,
        nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))

      cells.push({ column, row, nx, ny, nz, shade: shadeFor(nx, ny, nz), size: 0.7 + 0.3 * nz })
    }
  }

  return cells
}

export function squareCells(n: number): GyroCell[] {
  const half = (n - 1) / 2,
    R = n * 1.25

  const cells: GyroCell[] = []

  for (let row = 0; row < n; row++) {
    for (let column = 0; column < n; column++) {
      const corner = (row === 0 || row === n - 1) && (column === 0 || column === n - 1)

      const nx = (column - half) / R,
        ny = (row - half) / R

      const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
      cells.push({
        column,
        row,
        nx,
        ny,
        nz,
        shade: shadeFor(nx, ny, nz),
        size: (corner ? 0.5 : 1) * (0.86 + 0.14 * nz),
      })
    }
  }

  return cells
}

export const SEVEN = orbCells(7)

export const SQUARE_SEVEN = squareCells(7)

// MARK: Afterglow and flash

const FLASH_START = 0.2,
  FLASH_WINDOW = 0.1,
  FLASH_ATTACK = 0.03

function flashDelay(f: Flash, cell: GyroCell) {
  if (f.spread === "all") return 0

  if (f.spread === "ripple") return Math.min(1, Math.hypot(cell.nx, cell.ny)) * 0.24
  const a = Math.atan2(cell.ny, cell.nx) + HALF

  return ((a - TAU * Math.floor(a / TAU)) / TAU) * 0.36
}

const SPREAD_SECONDS: Record<Flash["spread"], number> = { all: 0, ripple: 0.24, sweep: 0.36 }

const flashDriven = (f: Flash) => FLASH_START + FLASH_WINDOW + SPREAD_SECONDS[f.spread]

function hashI(i: number) {
  const x = Math.sin(i * 12.9898 + 4.1) * 43758.5453

  return x - Math.floor(x)
}

const hashCell = (c: GyroCell) => hashI(c.row * 7 + c.column)

function shimmer(cell: GyroCell, t: number) {
  const i = cell.row * 7 + cell.column

  const f = 0.14 + 0.1 * hashI(i + 17),
    s = 0.5 + 0.5 * Math.sin(TAU * (t * f + hashI(i)))

  return 0.22 * Math.pow(s, 10)
}

function patternLight(p: Pattern, cell: GyroCell, onBand: number, t: number) {
  if (p === "condense") {
    const phase = t * 3 + hashCell(cell)
    const sparkle = G.gauss(phase - Math.floor(phase) - 0.5, 0.06)

    return sparkle * (1 - G.sstep(0.1, 1.0, t) * (1 - onBand))
  }

  return shimmer(cell, t) * G.sstep(0, 0.6, t)
}

const patternStill = (p: Pattern, cell: GyroCell) =>
  p === "condense" ? (hashCell(cell) > 0.72 ? 0.8 : 0) : shimmer(cell, 2.4)

const FADE_IN = 0.06,
  FADE_OUT = 0.2

export class GyroPhosphor {
  light: number[] = []
  heat: number[] = []
  weights: Partial<Record<Accent, number>> = {}
  attack = 0
  decay = 0
  release = 0.35
  patterns = new Map<Pattern, { amount: number; age: number }>()
  private flash: Flash | null = null
  private flashPending = false
  private design: Design | null = null
  private reduceMotion = false
  age = 0
  isSettled = true

  enter(design: Design, reduceMotion: boolean, immediate: boolean) {
    this.design = design
    this.reduceMotion = reduceMotion
    this.age = 0
    this.isSettled = false

    if (design.afterglow) {
      this.attack = design.afterglow.attack
      this.decay = design.afterglow.decay
      this.release = design.afterglow.release
    }

    if (design.pattern) {
      const prev = this.patterns.get(design.pattern)
      const amount = immediate || reduceMotion ? 1 : (prev?.amount ?? 0)
      this.patterns.set(design.pattern, { amount, age: amount < 1e-3 ? 0 : (prev?.age ?? 0) })
    }

    if (design.flash) this.flash = design.flash
    this.flashPending = design.flash != null && !immediate && !reduceMotion

    if (immediate) {
      this.light = []
      this.heat = []
      this.weights = {}

      for (const k of [...this.patterns.keys()]) if (k !== design.pattern) this.patterns.delete(k)
    }
  }

  apply(field: GyroField, cells: GyroCell[], dt: number) {
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
      const on = pattern === design.pattern,
        target = on ? 1 : 0

      const amount = rm
        ? target
        : state.amount + (target - state.amount) * (1 - Math.exp(-dt / (on ? FADE_IN : FADE_OUT)))

      if (!on && amount < 0.002) this.patterns.delete(pattern)
      else this.patterns.set(pattern, { amount, age: state.age + dt })
    }

    if (this.light.length !== field.dots.length) {
      this.light = field.dots.map((d) => d.light)
      this.heat = field.dots.map(() => 0)
    }

    let lag = 0,
      hottest = 0

    const fall = rm || this.decay < 1e-3 ? 1 : 1 - Math.exp(-dt / this.decay)

    for (const a of ACCENTS) {
      const target = field.weights[a] ?? 0,
        held = this.weights[a] ?? target

      const next = target >= held ? target : held + (target - held) * fall
      this.weights[a] = next
      lag = Math.max(lag, next - target)
    }

    field.weights = { ...this.weights }

    const tint = G.clamp(
      Object.values(this.weights).reduce((s, v) => s + Math.max(0, v ?? 0), 0),
      0,
      1,
    )

    let maxFresh = 1e-3

    for (const d of field.dots) maxFresh = Math.max(maxFresh, d.fresh)
    const flashing = this.flashPending && !rm ? (design.flash ?? null) : null
    const inFlashState = design.flash != null
    cells.forEach((cell, i) => {
      if (i >= field.dots.length) return
      const dot = field.dots[i]
      const onBand = dot.fresh / maxFresh

      let P = dot.light,
        fresh = dot.fresh

      for (const [pattern, state] of this.patterns) {
        if (state.amount <= 1e-3) continue
        const p = state.amount * (rm ? patternStill(pattern, cell) : patternLight(pattern, cell, onBand, state.age))
        P = Math.min(1.2, P + 0.95 * p)
        fresh = Math.max(fresh, 0.8 * p)
      }

      const v = this.light[i],
        tau = rm ? 0 : P > v ? this.attack : this.decay

      const next = tau < 1e-3 ? P : v + (P - v) * (1 - Math.exp(-dt / tau))
      this.light[i] = next
      lag = Math.max(lag, Math.abs(next - P))

      let drive = 0

      if (flashing) {
        const x = this.age - FLASH_START - flashDelay(flashing, cell)

        if (x >= 0 && x < FLASH_WINDOW) drive = 0.15 + 0.85 * onBand
      }

      const h = this.heat[i],
        ht = drive > h ? FLASH_ATTACK : (this.flash?.decay ?? 1)

      const hot = rm ? 0 : h + (drive - h) * (1 - Math.exp(-dt / ht))
      this.heat[i] = hot < 1e-4 && drive === 0 ? 0 : hot
      const a = (this.flash?.amount ?? 0) * this.heat[i]
      hottest = Math.max(hottest, a)
      dot.light = next + 0.7 * a
      dot.fresh = inFlashState ? Math.max(fresh * (0.3 + 0.7 * a), a) : Math.max(fresh, a)
      dot.accent = tint * G.sstep(0.3, 0.65, next) * (1 - a)
      dot.size *= 1 + (this.flash?.bloom ?? 0) * this.heat[i]
    })

    if (flashing && this.age >= flashDriven(flashing)) this.flashPending = false
    field.heat = hottest
    field.glow += 0.9 * hottest
    this.isSettled = rm || (!this.flashPending && hottest < 0.005 && lag < 0.002 && this.patterns.size === 0)
  }
}
