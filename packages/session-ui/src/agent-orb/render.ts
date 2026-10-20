// The orb's look and GPU pass, ported from opencode-ios AgentActivityGlyph.swift (`AgentActivityOrb.pack`) and
// AgentActivityShaders.metal (`activityOrbField`). One WebGL2 context serves every orb on the page: each frame
// draws the orbs that moved into tiles of one offscreen canvas, then copies each tile into its orb's 2D canvas, so
// Chromium's cap on live WebGL contexts never comes into play.

import { ACCENTS, G, type Accent, type GyroCell, type GyroField } from "./gyro"

type RGB = [number, number, number]

type Palette = { base: RGB; core: RGB; accents: Record<Accent, [RGB, RGB]>; hot: Partial<Record<Accent, [RGB, RGB]>> }

const DARK: Palette = {
  base: [0.7, 0.75, 0.84],
  core: [0.92, 0.95, 1.0],
  accents: {
    orange: [
      [1.0, 0.64, 0.3],
      [1.0, 0.88, 0.7],
    ],
    red: [
      [1.0, 0.32, 0.24],
      [1.0, 0.56, 0.46],
    ],
    green: [
      [0.2, 0.8, 0.42],
      [0.5, 0.93, 0.62],
    ],
    blue: [
      [0.42, 0.66, 1.0],
      [0.8, 0.9, 1.0],
    ],
  },
  hot: {
    green: [
      [0.86, 1.0, 0.9],
      [1, 1, 1],
    ],
    red: [
      [1.0, 0.9, 0.84],
      [1, 1, 1],
    ],
  },
}

const LIGHT: Palette = {
  base: [0.27, 0.32, 0.42],
  core: [0.09, 0.12, 0.2],
  accents: {
    orange: [
      [0.95, 0.52, 0.12],
      [0.78, 0.36, 0.02],
    ],
    red: [
      [0.85, 0.17, 0.12],
      [0.66, 0.08, 0.05],
    ],
    green: [
      [0.06, 0.55, 0.26],
      [0.02, 0.42, 0.18],
    ],
    blue: [
      [0.1, 0.45, 0.95],
      [0.02, 0.28, 0.72],
    ],
  },
  hot: {
    green: [
      [0.36, 0.86, 0.52],
      [0.22, 0.76, 0.4],
    ],
    red: [
      [1.0, 0.46, 0.36],
      [0.96, 0.32, 0.24],
    ],
  },
}

// Below 24 px the iOS values read faint on a 1× display, so small orbs light the unlit grid, the dots and the glow a
// little harder. 24 px and up use the app's numbers unchanged.
function boost(size: number) {
  const small = size < 24

  return { light: small ? 1.18 : 1, unlit: small ? 2.2 : 1, dot: small ? 1.12 : 1, glow: small ? 1.35 : 1 }
}

export const margin = (size: number) => Math.round(size * 0.42)

const diameter = (size: number) => size - (size >= 24 ? 4 : 2)

const mix = (a: RGB, b: RGB, t: number): RGB => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
]

function saturate(c: RGB, k: number): RGB {
  const l = c[0] * 0.299 + c[1] * 0.587 + c[2] * 0.114

  return [l + (c[0] - l) * k, l + (c[1] - l) * k, l + (c[2] - l) * k]
}

function glowColor(a: RGB, b: RGB, dark: boolean): RGB {
  const c = dark ? saturate(mix(a, b, 0.5), 1.5) : mix(saturate(a, 1.95), [1, 1, 1], 0.15)

  return [G.clamp(c[0], 0, 1), G.clamp(c[1], 0, 1), G.clamp(c[2], 0, 1)]
}

function blend(pairs: Partial<Record<Accent, [RGB, RGB]>>, weights: GyroField["weights"]) {
  const picked = ACCENTS.flatMap((key) => {
    const weight = weights[key] ?? 0
    const pair = pairs[key]

    return weight > 1e-3 && pair ? [{ weight, pair }] : []
  })

  const sum = picked.reduce((total, item) => total + item.weight, 0)

  if (sum < 1e-3) return undefined

  const channel = (i: 0 | 1, c: number) =>
    picked.reduce((total, item) => total + item.pair[i][c] * item.weight, 0) / sum

  const at = (i: 0 | 1): RGB => [channel(i, 0), channel(i, 1), channel(i, 2)]

  return { sum, color: at(0), core: at(1) }
}

/** Packs one orb's frame into the shader's 268 floats (see `activityOrbField`). */
export function pack(
  field: GyroField,
  cells: GyroCell[],
  size: number,
  dark: boolean,
  scale: number,
  out: Float32Array,
) {
  const palette = dark ? DARK : LIGHT
  const tune = boost(size)
  const side = size + 2 * margin(size)
  const accent = blend(palette.accents, field.weights)
  const tint = Math.min(1, accent?.sum ?? 0)
  const heat = G.clamp(field.heat, 0, 1)
  const hot = heat > 1e-3 ? blend(palette.hot, field.weights) : undefined

  const glowBase = mix(
    glowColor(palette.base, palette.core, dark),
    accent ? glowColor(accent.color, accent.core, dark) : palette.base,
    accent ? tint : 0,
  )

  const glowRGB = hot ? mix(glowBase, glowColor(hot.color, hot.core, dark), heat) : glowBase
  const neutral = hot ? mix(palette.base, hot.color, heat) : palette.base
  const neutralCore = hot ? mix(palette.core, hot.core, heat) : palette.core
  const pitchPixels = Math.max(2, Math.round((diameter(size) * scale) / 7))
  const pitch = pitchPixels / scale
  const origin = Math.floor((side * scale - 7 * pitch * scale) / 2) / scale
  const peak = (dark ? 0.3 : 0.19) * 0.55 * 1.5 * (dark ? 1 : 0.45) * tune.glow
  const unlit = (dark ? 0.06 : 0.075) * tune.unlit

  out.fill(0)
  out.set([
    origin,
    origin,
    pitch,
    scale,
    field.glow,
    peak,
    dark ? 1 : 0,
    unlit,
    ...glowRGB,
    ...neutral,
    ...neutralCore,
    ...(accent?.color ?? palette.base),
    ...(accent?.core ?? palette.core),
  ])
  cells.forEach((cell, i) => {
    const dot = field.dots[i]

    if (!dot) return
    out.set(
      [dot.light * tune.light, dot.fresh, dot.accent, dot.size * tune.dot, 1],
      23 + (cell.row * 7 + cell.column) * 5,
    )
  })
}

const VERTEX = `#version 300 es
in vec2 p;
void main() { gl_Position = vec4(p, 0.0, 1.0); }`

// activityOrbField, line for line. gl_FragCoord counts from the atlas corner, so uOrigin moves it into the tile.
const FRAGMENT = `#version 300 es
precision highp float;
uniform vec4 uP[67];
uniform vec2 uView;
uniform vec2 uOrigin;
out vec4 outColor;
float P(int i) { return uP[i >> 2][i & 3]; }
void main() {
  float scale = max(1.0, P(3));
  vec2 frag = gl_FragCoord.xy - uOrigin;
  vec2 position = vec2(frag.x, uView.y - frag.y) / scale;
  vec2 origin = vec2(P(0), P(1));
  float pitch = P(2);
  float glowAmount = P(4), glowPeak = P(5), isDark = P(6), a0 = P(7);
  vec3 glowRGB = vec3(P(8), P(9), P(10));
  vec3 neutral = vec3(P(11), P(12), P(13));
  vec3 neutralCore = vec3(P(14), P(15), P(16));
  vec3 accent = vec3(P(17), P(18), P(19));
  vec3 accentCore = vec3(P(20), P(21), P(22));
  vec2 centre = origin + vec2(3.5 * pitch);
  vec3 premul = vec3(0.0);
  float alphaAcc = 0.0;
  if (glowAmount > 1e-3) {
    float sigma = 2.2;
    float distCells = length(position - centre) / pitch;
    if (distCells < 3.6 * sigma) {
      float g = min(1.0, glowAmount * exp(-distCells * distCells / (2.0 * sigma * sigma))) * glowPeak;
      premul = glowRGB * g;
      alphaAcc = g;
    }
  }
  vec2 rel = (position - origin) / pitch;
  if (rel.x < -0.6 || rel.y < -0.6 || rel.x > 7.6 || rel.y > 7.6) { outColor = vec4(premul, alphaAcc); return; }
  int colCenter = clamp(int(floor(rel.x)), 0, 6);
  int rowCenter = clamp(int(floor(rel.y)), 0, 6);
  float halfPx = 0.5 / scale;
  float top = isDark > 0.5 ? 0.96 : 1.0;
  for (int dr = -1; dr <= 1; dr++) {
    int r = rowCenter + dr;
    if (r < 0 || r > 6) continue;
    for (int dc = -1; dc <= 1; dc++) {
      int c = colCenter + dc;
      if (c < 0 || c > 6) continue;
      int base = 23 + (r * 7 + c) * 5;
      if (P(base + 4) < 0.5) continue;
      vec2 dotCenter = origin + vec2((float(c) + 0.5) * pitch, (float(r) + 0.5) * pitch);
      float dist = length(position - dotCenter);
      if (dist > pitch + halfPx) continue;
      float L = clamp(P(base), 0.0, 1.0);
      float haloPeak = 0.22 * L * L;
      if (haloPeak <= 0.008 && dist > 0.48 * pitch + halfPx) continue;
      float fresh = clamp(P(base + 1), 0.0, 1.0);
      float dotAccent = clamp(P(base + 2), 0.0, 1.0);
      float dotSize = P(base + 3);
      float shrink = 1.0 + ((0.82 + 0.18 * fresh) - 1.0) * smoothstep(0.03, 0.2, L);
      float radius = (0.25 + 0.17 * pow(max(L, 1e-5), 0.6)) * shrink * pitch * dotSize;
      float outer = radius + 0.5 * pitch;
      if (dist > (haloPeak > 0.008 ? outer : radius) + halfPx) continue;
      float expPow = (isDark > 0.5 ? 0.9 : 0.75) * (1.4 - 0.4 * fresh);
      float dotAlpha = a0 + (top - a0) * pow(max(L, 1e-5), expPow);
      float core = clamp(L * L * 1.1, 0.0, 0.9) * (0.3 + 0.7 * fresh);
      vec3 rgb = mix(mix(neutral, neutralCore, core), mix(accent, accentCore, core), dotAccent);
      if (haloPeak > 0.008) {
        float inner = max(0.0, radius - 0.01 * outer);
        if (dist >= inner && dist <= outer + halfPx) {
          float innerRamp = dist < radius ? clamp((dist - inner) / max(1e-4, radius - inner), 0.0, 1.0) : 1.0;
          float d = max(0.0, dist - radius);
          float outerCov = clamp((outer - dist) * scale + 0.5, 0.0, 1.0);
          float hAlpha = haloPeak * exp(-d / (0.12 * pitch)) * innerRamp * outerCov;
          premul = premul * (1.0 - hAlpha) + rgb * hAlpha;
          alphaAcc = alphaAcc * (1.0 - hAlpha) + hAlpha;
        }
      }
      if (dist <= radius + halfPx) {
        float cov = clamp((radius - dist) * scale + 0.5, 0.0, 1.0);
        float a = dotAlpha * cov;
        premul = premul * (1.0 - a) + rgb * a;
        alphaAcc = alphaAcc * (1.0 - a) + a;
      }
    }
  }
  outColor = vec4(premul, alphaAcc);
}`

export type Tile = { ctx: CanvasRenderingContext2D; side: number; packed: Float32Array }

export class OrbRenderer {
  private uniform: {
    packed: WebGLUniformLocation | null
    view: WebGLUniformLocation | null
    origin: WebGLUniformLocation | null
  }

  private constructor(
    private canvas: HTMLCanvasElement,
    private gl: WebGL2RenderingContext,
    program: WebGLProgram,
  ) {
    this.uniform = {
      packed: gl.getUniformLocation(program, "uP"),
      view: gl.getUniformLocation(program, "uView"),
      origin: gl.getUniformLocation(program, "uOrigin"),
    }
  }

  /** Undefined when WebGL2 is unavailable or the shader fails to build; callers fall back to the static mark. */
  static create() {
    const canvas = document.createElement("canvas")
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false })

    if (!gl) return undefined
    const program = link(gl)

    if (!program) return undefined
    gl.useProgram(program)
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)
    gl.disable(gl.BLEND)
    gl.enable(gl.SCISSOR_TEST)

    return new OrbRenderer(canvas, gl, program)
  }

  /** Draws every tile into rows of the atlas, then copies each into its own canvas. */
  draw(tiles: Tile[]) {
    if (tiles.length === 0) return
    const gl = this.gl

    const rows = tiles.reduce<{ x: number; y: number; row: number; width: number; at: [number, number][] }>(
      (layout, tile) => {
        const wrap = layout.x + tile.side > 2048
        const x = wrap ? 0 : layout.x
        const y = wrap ? layout.y + layout.row : layout.y
        layout.at.push([x, y])
        layout.x = x + tile.side
        layout.y = y
        layout.row = wrap ? tile.side : Math.max(layout.row, tile.side)
        layout.width = Math.max(layout.width, layout.x)

        return layout
      },
      { x: 0, y: 0, row: 0, width: 0, at: [] },
    )

    const height = rows.y + rows.row

    if (this.canvas.width < rows.width || this.canvas.height < height) {
      this.canvas.width = Math.max(this.canvas.width, rows.width)
      this.canvas.height = Math.max(this.canvas.height, height)
    }

    const top = this.canvas.height

    tiles.forEach((tile, i) => {
      const [x, y] = rows.at[i]
      const bottom = top - y - tile.side
      gl.viewport(x, bottom, tile.side, tile.side)
      gl.scissor(x, bottom, tile.side, tile.side)
      gl.uniform4fv(this.uniform.packed, tile.packed)
      gl.uniform2f(this.uniform.view, tile.side, tile.side)
      gl.uniform2f(this.uniform.origin, x, bottom)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
    })
    tiles.forEach((tile, i) => {
      const [x, y] = rows.at[i]
      tile.ctx.clearRect(0, 0, tile.side, tile.side)
      tile.ctx.drawImage(this.canvas, x, y, tile.side, tile.side, 0, 0, tile.side, tile.side)
    })
  }
}

function link(gl: WebGL2RenderingContext) {
  const compile = (type: number, source: string) => {
    const shader = gl.createShader(type)

    if (!shader) return undefined
    gl.shaderSource(shader, source)
    gl.compileShader(shader)

    return gl.getShaderParameter(shader, gl.COMPILE_STATUS) ? shader : undefined
  }

  const vertex = compile(gl.VERTEX_SHADER, VERTEX)
  const fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT)
  const program = gl.createProgram()

  if (!vertex || !fragment || !program) return undefined
  gl.attachShader(program, vertex)
  gl.attachShader(program, fragment)
  gl.bindAttribLocation(program, 0, "p")
  gl.linkProgram(program)

  return gl.getProgramParameter(program, gl.LINK_STATUS) ? program : undefined
}
