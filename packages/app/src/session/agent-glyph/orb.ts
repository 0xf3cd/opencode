import { ACCENTS, CELLS, type ActivityAccent, type GyroField } from "./gyro"

// Draws the orb on a 2D canvas, as the iOS app's `activityOrbField` shader does on the GPU: a soft radial glow, then
// each dot of the pixel-snapped 7 × 7 grid with its halo and anti-aliased disc. Colours come from theme tokens set on
// the canvas as `--agent-glyph-*` custom properties.

type RGB = [number, number, number]

export type OrbPalette = {
  dark: boolean
  base: RGB
  core: RGB
  accents: Record<ActivityAccent, [RGB, RGB]>
  hot: Record<ActivityAccent, [RGB, RGB]>
}

const WHITE: RGB = [1, 1, 1]

const BLACK: RGB = [0, 0, 0]

const SIGMA = 2.2

const GLOW_STRENGTH = 1.5

const LIGHT_GLOW = 0.45

const SHADER_GLOW = 0.55

export const orbMargin = (size: number) => Math.round(size * 0.42)

const diameter = (size: number) => size - (size >= 24 ? 4 : 2)

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

const add = (a: RGB, b: RGB, w: number): RGB => [a[0] + b[0] * w, a[1] + b[1] * w, a[2] + b[2] * w]

const scaled = (a: RGB, k: number): RGB => [a[0] * k, a[1] * k, a[2] * k]

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

const sstep = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a))

  return t * t * (3 - 2 * t)
}

const saturate = (c: RGB, k: number): RGB => {
  const l = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114

  return [clamp01(l + (c[0] - l) * k), clamp01(l + (c[1] - l) * k), clamp01(l + (c[2] - l) * k)]
}

// Glow colour, as the scope derives it from a trace's two colours.
const glowColor = (a: RGB, b: RGB, dark: boolean) =>
  dark ? saturate(mix(a, b, 0.5), 1.5) : mix(saturate(a, 1.95), WHITE, 0.15)

const rgba = (c: RGB, a: number) =>
  `rgba(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)},${clamp01(a)})`

const resolved = new Map<string, RGB>()

let probe: CanvasRenderingContext2D | undefined | null

// Any CSS colour the canvas understands, as sRGB.
function resolveColor(css: string): RGB {
  const cached = resolved.get(css)

  if (cached) return cached
  probe ??= document.createElement("canvas").getContext("2d", { willReadFrequently: true })

  if (!probe) return [0.5, 0.5, 0.5]
  probe.clearRect(0, 0, 1, 1)
  probe.fillStyle = "#000"
  probe.fillStyle = css
  probe.fillRect(0, 0, 1, 1)
  const data = probe.getImageData(0, 0, 1, 1).data
  const color: RGB = [data[0]! / 255, data[1]! / 255, data[2]! / 255]
  resolved.set(css, color)

  return color
}

export function readPalette(element: Element): OrbPalette {
  const style = getComputedStyle(element)
  const read = (name: string) => resolveColor(style.getPropertyValue(name).trim() || "currentColor")
  const core = read("--agent-glyph-core")
  const dark = core[0] * 0.299 + core[1] * 0.587 + core[2] * 0.114 > 0.5

  const accent = (name: string): [RGB, RGB] => {
    const color = read(name)

    return [color, mix(color, core, 0.45)]
  }

  const accents = {
    orange: accent("--agent-glyph-orange"),
    red: accent("--agent-glyph-red"),
    green: accent("--agent-glyph-green"),
    blue: accent("--agent-glyph-blue"),
  }

  // The flash the settled colour cools from: near white on dark, a bright accent on light.
  // SAFETY: built from every key of ACCENTS.
  const hot = Object.fromEntries(
    ACCENTS.map((key) => {
      const color = accents[key][0]

      return [key, dark ? [mix(color, WHITE, 0.8), WHITE] : [mix(color, WHITE, 0.3), mix(color, WHITE, 0.15)]]
    }),
  ) as Record<ActivityAccent, [RGB, RGB]>

  return { dark, base: read("--agent-glyph-base"), core, accents, hot }
}

export function drawOrb(
  ctx: CanvasRenderingContext2D,
  field: GyroField,
  size: number,
  scale: number,
  palette: OrbPalette,
) {
  const side = size + 2 * orbMargin(size)
  const dark = palette.dark
  ctx.setTransform(scale, 0, 0, scale, 0, 0)
  ctx.clearRect(0, 0, side, side)

  // The accent blended by the state's colour weights.
  const blend = ACCENTS.reduce(
    (sum, key) => {
      const weight = field.weights[key]

      if (weight <= 1e-3) return sum
      const pair = palette.accents[key]

      return {
        weight: sum.weight + weight,
        accent: add(sum.accent, pair[0], weight),
        core: add(sum.core, pair[1], weight),
      }
    },
    { weight: 0, accent: BLACK, core: BLACK },
  )

  const tinted = blend.weight >= 1e-3
  const accent = tinted ? scaled(blend.accent, 1 / blend.weight) : palette.base
  const accentCore = tinted ? scaled(blend.core, 1 / blend.weight) : palette.core
  const tint = Math.min(1, blend.weight)
  const neutralGlow = glowColor(palette.base, palette.core, dark)
  const heat = clamp01(field.heat)
  const hot = heat > 1e-3 ? hotPair(palette, field.weights) : undefined
  // A flash warms the neutral pair toward its hot colour: lit dots cool from it into the accent, dim ones to pearl.
  const neutral = hot ? mix(palette.base, hot[0], heat) : palette.base
  const neutralCore = hot ? mix(palette.core, hot[1], heat) : palette.core
  const baseGlow = mix(neutralGlow, glowColor(accent, accentCore, dark), tinted ? tint : 0)
  const glowRGB = hot ? mix(baseGlow, glowColor(hot[0], hot[1], dark), heat) : baseGlow

  // The grid snaps to device pixels: a whole number of pixels per cell.
  const pitch = Math.max(2, Math.round((diameter(size) * scale) / 7)) / scale
  const gridSide = 7 * pitch
  const origin = Math.floor((side * scale - gridSide * scale) / 2) / scale
  const centre = origin + gridSide / 2
  const peak = (dark ? 0.3 : 0.19) * SHADER_GLOW * GLOW_STRENGTH * (dark ? 1 : LIGHT_GLOW)
  const a0 = dark ? 0.06 : 0.075
  const top = dark ? 0.96 : 1

  // 1. Central Gaussian glow.
  if (field.glow > 1e-3) {
    const reach = 3.6 * SIGMA
    const gradient = ctx.createRadialGradient(centre, centre, 0, centre, centre, reach * pitch)

    for (let i = 0; i <= 8; i++) {
      const cells = (i / 8) * reach
      gradient.addColorStop(
        i / 8,
        rgba(glowRGB, Math.min(1, field.glow * Math.exp(-(cells * cells) / (2 * SIGMA * SIGMA))) * peak),
      )
    }

    ctx.fillStyle = gradient
    ctx.fillRect(0, 0, side, side)
  }

  // 2. Each dot: its halo, then its disc.
  CELLS.forEach((cell, i) => {
    const dot = field.dots[i]

    if (!dot) return
    const P = clamp01(dot.light)
    const fresh = clamp01(dot.fresh)
    const x = origin + (cell.column + 0.5) * pitch
    const y = origin + (cell.row + 0.5) * pitch
    const shrink = 1 + (0.82 + 0.18 * fresh - 1) * sstep(0.03, 0.2, P)
    const radius = (0.25 + 0.17 * Math.pow(Math.max(P, 1e-5), 0.6)) * shrink * pitch * dot.size
    const expPow = (dark ? 0.9 : 0.75) * (1.4 + (1 - 1.4) * fresh)
    const alpha = a0 + (top - a0) * Math.pow(Math.max(P, 1e-5), expPow)
    const core = Math.min(0.9, P * P * 1.1) * (0.3 + 0.7 * fresh)
    const rgb = mix(mix(neutral, neutralCore, core), mix(accent, accentCore, core), clamp01(dot.accent))
    const haloPeak = 0.22 * P * P

    if (haloPeak > 0.008) {
      const outer = radius + 0.5 * pitch
      const halo = ctx.createRadialGradient(x, y, radius, x, y, outer)

      for (let j = 0; j <= 4; j++) {
        halo.addColorStop(j / 4, rgba(rgb, haloPeak * Math.exp(-((j / 4) * 0.5 * pitch) / (0.12 * pitch))))
      }

      ctx.fillStyle = halo
      ctx.beginPath()
      ctx.arc(x, y, outer, 0, Math.PI * 2)
      ctx.fill()
    }

    ctx.fillStyle = rgba(rgb, alpha)
    ctx.beginPath()
    ctx.arc(x, y, radius, 0, Math.PI * 2)
    ctx.fill()
  })
}

// The flash colour for the state's accents, blended by their weights; none when no accent flashes.
function hotPair(palette: OrbPalette, weights: Record<ActivityAccent, number>): [RGB, RGB] | undefined {
  const total = ACCENTS.reduce((sum, key) => sum + (weights[key] > 1e-3 ? weights[key] : 0), 0)

  if (total < 1e-3) return

  return ACCENTS.reduce<[RGB, RGB]>(
    (sum, key) => {
      const weight = weights[key] > 1e-3 ? weights[key] / total : 0

      return [add(sum[0], palette.hot[key][0], weight), add(sum[1], palette.hot[key][1], weight)]
    },
    [BLACK, BLACK],
  )
}
