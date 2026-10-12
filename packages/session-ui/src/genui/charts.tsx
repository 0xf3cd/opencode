import { createMemo, createSignal, createUniqueId, For, Index, Show, type JSX } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import type { GenUICatalog } from "@opencode/plugin-genui/catalog"
import { useI18n } from "@opencode/ui/context/i18n"

/*
 * Charts follow the console dashboards: monochrome ink for one series, a v2 hue ramp only when several series need
 * telling apart, and state colors only for meaning. Grids are dashed 0.5px muted lines with a solid baseline, labels
 * are faint 10px tabular figures, and hovering a column dims the rest and opens a raised tooltip. Line geometry, area
 * gradients and square end markers follow the stats site.
 */

export type Format = (typeof GenUICatalog.formats)[number]

type Tone = (typeof GenUICatalog.tones)[number]

type Series = { readonly name: string; readonly values: readonly (number | null)[] }

type Item = { readonly label: string; readonly value: number }

const HEIGHT = 184

const PAD = { top: 8, bottom: 22, left: 44, right: 8 } as const

const SERIES = 6

/** The CSS color of the series at `index`: ink when it is the only one, otherwise the next hue of the ramp. */
export const seriesColor = (index: number, count: number) =>
  count <= 1 ? "var(--genui-ink)" : `var(--genui-series-${(index % SERIES) + 1})`

const toneColor = (tone: Tone | undefined) =>
  tone === undefined || tone === "neutral" ? "var(--genui-ink)" : `var(--v2-state-fg-${tone})`

// ─── Numbers ───────────────────────────────────────────────────────────────

const trim = (value: number, digits: number) => value.toFixed(digits).replace(/\.0+$|(\.\d*[1-9])0+$/u, "$1")

/** Prints a raw number the way the console does: compact k/M/B, USD, percent, durations and bytes. */
export function formatValue(value: number, format: Format = "compact"): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? "−" : ""

  if (format === "number") return value.toLocaleString("en-US", { maximumFractionDigits: 2 })

  if (format === "percent") {
    if (value === 0) return "0%"

    if (abs < 0.1) return `${sign}<0.1%`

    return `${sign}${trim(abs, abs < 10 ? 1 : 0)}%`
  }

  if (format === "currency") {
    if (abs > 0 && abs < 0.01) return `${sign}<$0.01`

    if (abs >= 1000) return `${sign}$${compact(abs)}`

    return `${sign}$${abs >= 100 && Number.isInteger(abs) ? abs.toFixed(0) : abs.toFixed(2)}`
  }

  if (format === "duration") {
    if (abs < 1000) return `${sign}${Math.round(abs)} ms`

    if (abs < 60_000) return `${sign}${trim(abs / 1000, abs < 10_000 ? 2 : 1)} s`

    const minutes = Math.floor(abs / 60_000)

    return `${sign}${minutes}m ${String(Math.round((abs % 60_000) / 1000)).padStart(2, "0")}s`
  }

  if (format === "bytes") {
    const units = ["B", "KB", "MB", "GB", "TB"]
    const power = Math.min(units.length - 1, abs > 0 ? Math.floor(Math.log(abs) / Math.log(1024)) : 0)

    return `${sign}${trim(abs / 1024 ** power, power === 0 ? 0 : 1)} ${units[power]}`
  }

  return `${sign}${compact(abs)}`
}

function compact(abs: number) {
  if (abs >= 1e9) return `${trim(abs / 1e9, 1)}B`

  if (abs >= 1e6) return `${trim(abs / 1e6, 1)}M`

  if (abs >= 1e3) return `${trim(abs / 1e3, 1)}k`

  return trim(abs, abs < 10 ? 2 : abs < 100 ? 1 : 0)
}

/** A round axis maximum split into three steps (1, 2 or 5 times a power of ten), as the console's usage chart. */
export function niceMax(max: number, format?: Format) {
  if (max <= 0) return 1

  // A percent scale never needs to run past 100%.
  if (format === "percent" && max <= 100 && max > 75) return 100
  const rough = max / 3
  const magnitude = 10 ** Math.floor(Math.log10(rough))
  const step = ([1, 2, 2.5, 5, 10].find((factor) => factor * magnitude >= rough) ?? 10) * magnitude

  return step * 3
}

/** Which x labels to print: all of up to seven, otherwise about six evenly spaced plus the last. */
export function labelIndexes(count: number) {
  if (count <= 7) return Array.from({ length: count }, (_, index) => index)
  const step = Math.ceil(count / 6)
  const indexes = Array.from({ length: count }, (_, index) => index).filter((index) => index % step === 0)

  return indexes.at(-1) === count - 1 ? indexes : [...indexes, count - 1]
}

/** A smooth path through points (tension 1/6, as the stats site), split at gaps. */
export function smoothPath(
  points: readonly ({ x: number; y: number } | null)[],
  bounds?: { top: number; bottom: number },
) {
  // Control points stay inside the plot, as the stats site clamps them, so a spike never dips below the baseline.
  const clamp = (y: number) => (bounds ? Math.min(bounds.bottom, Math.max(bounds.top, y)) : y)
  const runs: { x: number; y: number }[][] = [[]]

  points.forEach((point) => {
    if (point) runs.at(-1)?.push(point)
    else runs.push([])
  })

  return runs
    .flatMap((run) =>
      run.length === 0
        ? []
        : run
            .map((point, index) => {
              if (index === 0) return `M${point.x},${point.y}`
              const before = run[index - 2] ?? run[index - 1]
              const previous = run[index - 1]
              const next = run[index + 1] ?? point

              return `C${previous.x + (point.x - before.x) / 6},${clamp(previous.y + (point.y - before.y) / 6)} ${point.x - (next.x - previous.x) / 6},${clamp(point.y - (next.y - previous.y) / 6)} ${point.x},${point.y}`
            })
            .join(""),
    )
    .join("")
}

// ─── Shared pieces ─────────────────────────────────────────────────────────

/** The chart's measured width, so geometry is laid out in real pixels and text never scales. */
function createWidth() {
  const [width, setWidth] = createSignal(0)

  return {
    width,
    ref: (element: HTMLElement) => createResizeObserver(element, (rect) => setWidth(rect.width)),
  }
}

type Row = { readonly color?: string; readonly name?: string; readonly value: string }

/** The console's tooltip: a raised base surface with a muted heading and one row per value. */
function Tooltip(props: { x: number; width: number; title: string; rows: readonly Row[] }) {
  const flip = () => props.x + 20 + 180 > props.width

  return (
    <div
      data-slot="genui-chart-tooltip"
      style={{ left: `${props.x}px`, transform: flip() ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
    >
      <div data-slot="genui-chart-tooltip-title">{props.title}</div>
      <For each={props.rows}>
        {(row) => (
          <div data-slot="genui-chart-tooltip-row">
            <Show when={row.color}>{(color) => <i style={{ background: color() }} />}</Show>
            <Show when={row.name}>{(name) => <span>{name()}</span>}</Show>
            <b>{row.value}</b>
          </div>
        )}
      </For>
    </div>
  )
}

/** Swatches for several series; hovering one highlights it across the chart. */
function Legend(props: { names: readonly string[]; colors: readonly string[]; onHover: (index?: number) => void }) {
  return (
    <Show when={props.names.length > 1}>
      <div data-slot="genui-chart-legend">
        <Index each={props.names}>
          {(name, index) => (
            <span onMouseEnter={() => props.onHover(index)} onMouseLeave={() => props.onHover(undefined)}>
              <i style={{ background: props.colors[index] }} />
              {name()}
            </span>
          )}
        </Index>
      </div>
    </Show>
  )
}

/** Dashed gridlines at a third, two thirds and the top of the scale, a solid baseline, and their labels. */
function Grid(props: {
  width: number
  max: number
  format?: Format
  right?: { max: number; format?: Format }
  left?: number
}) {
  const plot = () => HEIGHT - PAD.top - PAD.bottom
  const left = () => props.left ?? PAD.left

  return (
    <For each={[3, 2, 1, 0]}>
      {(step) => {
        const y = () => PAD.top + plot() - (step / 3) * plot()

        return (
          <g>
            <line
              x1={left()}
              x2={props.width - (props.right ? PAD.left : PAD.right)}
              y1={y()}
              y2={y()}
              data-slot="genui-chart-grid"
              stroke-dasharray={step === 0 ? undefined : "4 3"}
            />
            <text x={left() - 8} y={y() + 3.5} text-anchor="end" data-slot="genui-chart-label">
              {formatValue((props.max * step) / 3, props.format)}
            </text>
            <Show when={props.right}>
              {(right) => (
                <text x={props.width - PAD.left + 8} y={y() + 3.5} text-anchor="start" data-slot="genui-chart-label">
                  {formatValue((right().max * step) / 3, right().format)}
                </text>
              )}
            </Show>
          </g>
        )
      }}
    </For>
  )
}

/** Anchors the first label to the start, the last to the end, and the rest to their middle. */
function edgeAnchor(index: number, last: number) {
  if (last === 0) return "middle"

  if (index === 0) return "start"

  if (index === last) return "end"

  return "middle"
}

/** x labels under the plot, the first and last anchored to the plot's edges. */
function XLabels(props: { labels: readonly string[]; x: (index: number) => number; left: number; right: number }) {
  return (
    <For each={labelIndexes(props.labels.length)}>
      {(index) => {
        const anchor = () => edgeAnchor(index, props.labels.length - 1)

        const x = () => {
          if (anchor() === "start") return Math.max(props.left, props.x(index) - 4)

          if (anchor() === "end") return Math.min(props.right, props.x(index) + 4)

          return props.x(index)
        }

        return (
          <text x={x()} y={HEIGHT - 6} text-anchor={anchor()} data-slot="genui-chart-label">
            {props.labels[index]}
          </text>
        )
      }}
    </For>
  )
}

/** The console's hover column: a soft vertical wash behind the hovered slot. */
function Highlight(props: { x: number; width: number }) {
  const id = createUniqueId()

  return (
    <>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="var(--genui-ink)" stop-opacity="0.04" />
          <stop offset="75%" stop-color="var(--genui-ink)" stop-opacity="0.04" />
          <stop offset="100%" stop-color="var(--genui-ink)" stop-opacity="0" />
        </linearGradient>
      </defs>
      <rect x={props.x} y={0} width={props.width} height={HEIGHT - PAD.bottom + 8} fill={`url(#${id})`} />
    </>
  )
}

function Frame(props: { children: JSX.Element; legend?: JSX.Element; label: string }) {
  return (
    <figure data-component="genui-chart" aria-label={props.label}>
      {props.legend}
      {props.children}
    </figure>
  )
}

const present = (series: readonly (Series | null)[]) => series.filter((item): item is Series => item !== null)

const maxOf = (values: readonly (number | null)[]) => Math.max(0, ...values.map((value) => value ?? 0))

// ─── Bars ──────────────────────────────────────────────────────────────────

export function BarChart(props: {
  labels: readonly string[]
  series: readonly (Series | null)[]
  stacked?: boolean | null
  format?: Format | null
}) {
  const i18n = useI18n()
  const size = createWidth()
  const [hovered, setHovered] = createSignal<number>()
  const [focus, setFocus] = createSignal<number>()
  const series = createMemo(() => present(props.series))
  const format = () => props.format ?? "compact"
  const count = () => Math.max(1, props.labels.length)
  const plot = () => HEIGHT - PAD.top - PAD.bottom
  const plotWidth = () => Math.max(0, size.width() - PAD.left - PAD.right)
  const slot = () => plotWidth() / count()

  const max = createMemo(() =>
    niceMax(
      props.stacked
        ? Math.max(
            0,
            ...props.labels.map((_, index) => series().reduce((sum, item) => sum + (item.values[index] ?? 0), 0)),
          )
        : Math.max(0, ...series().map((item) => maxOf(item.values))),
      format(),
    ),
  )

  const groups = () => (props.stacked || series().length === 1 ? 1 : series().length)

  const barWidth = () =>
    Math.max(
      2,
      Math.min(groups() === 1 ? 36 : 16, (slot() * (groups() === 1 ? 2 / 3 : 0.8)) / groups() - (groups() > 1 ? 2 : 0)),
    )

  const center = (index: number) => PAD.left + slot() * (index + 0.5)
  const height = (value: number | null) => (value && value > 0 ? Math.max(2, (value / max()) * plot()) : 0)
  const baseline = () => PAD.top + plot()
  const colors = () => series().map((_, index) => seriesColor(index, series().length))

  const opacity = (index: number, seriesIndex: number) => {
    const column = hovered()
    const single = series().length === 1

    if (focus() !== undefined && focus() !== seriesIndex) return 0.25

    if (column === undefined) return single ? 0.6 : 1

    if (column !== index) return 0.25

    return 1
  }

  return (
    <Frame
      label={series()
        .map((item) => item.name)
        .join(", ")}
      legend={<Legend names={series().map((item) => item.name)} colors={colors()} onHover={setFocus} />}
    >
      <div data-slot="genui-chart-plot" ref={size.ref} onMouseLeave={() => setHovered(undefined)}>
        <Show when={size.width() > 0}>
          <svg width={size.width()} height={HEIGHT} role="img">
            <Show when={hovered() !== undefined}>
              <Highlight x={PAD.left + slot() * (hovered() ?? 0)} width={slot()} />
            </Show>
            <Grid width={size.width()} max={max()} format={format()} />
            <Index each={props.labels}>
              {(_, index) => (
                <g>
                  <For each={series()}>
                    {(item, seriesIndex) => {
                      const value = () => item.values[index] ?? null

                      const below = () =>
                        props.stacked
                          ? series()
                              .slice(0, seriesIndex())
                              .reduce((sum, other) => sum + (other.values[index] ?? 0), 0)
                          : 0

                      const x = () =>
                        groups() === 1
                          ? center(index) - barWidth() / 2
                          : center(index) - (groups() * (barWidth() + 2)) / 2 + seriesIndex() * (barWidth() + 2) + 1

                      const top = () => baseline() - height(below() + (value() ?? 0))

                      const h = () =>
                        height(below() + (value() ?? 0)) -
                        height(below()) -
                        (props.stacked && seriesIndex() > 0 ? 1 : 0)

                      return (
                        <Show
                          when={(value() ?? 0) > 0}
                          fallback={
                            <Show when={seriesIndex() === 0 && !props.stacked}>
                              <rect
                                x={x()}
                                y={baseline() - 1}
                                width={barWidth()}
                                height={1}
                                data-slot="genui-chart-empty"
                              />
                            </Show>
                          }
                        >
                          <rect
                            x={x()}
                            y={top()}
                            width={barWidth()}
                            height={Math.max(1, h())}
                            data-slot="genui-chart-underlay"
                          />
                          <rect
                            x={x()}
                            y={top()}
                            width={barWidth()}
                            height={Math.max(1, h())}
                            fill={colors()[seriesIndex()]}
                            opacity={opacity(index, seriesIndex())}
                            data-slot="genui-chart-bar"
                          />
                        </Show>
                      )
                    }}
                  </For>
                  <rect
                    x={PAD.left + slot() * index}
                    y={0}
                    width={slot()}
                    height={baseline()}
                    fill="transparent"
                    onMouseEnter={() => setHovered(index)}
                  />
                </g>
              )}
            </Index>
            <XLabels labels={props.labels} x={center} left={PAD.left} right={size.width() - PAD.right} />
          </svg>
          <Show when={hovered()} keyed>
            {(index) => (
              <Tooltip
                x={center(index)}
                width={size.width()}
                title={props.labels[index] ?? ""}
                rows={[
                  ...series().map((item, seriesIndex) => ({
                    color: series().length > 1 ? colors()[seriesIndex] : undefined,
                    name: series().length > 1 ? item.name : undefined,
                    value: formatValue(item.values[index] ?? 0, format()),
                  })),
                  ...(props.stacked && series().length > 1
                    ? [
                        {
                          name: i18n.t("ui.genui.total"),
                          value: formatValue(
                            series().reduce((sum, item) => sum + (item.values[index] ?? 0), 0),
                            format(),
                          ),
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </Show>
        </Show>
      </div>
    </Frame>
  )
}

// ─── Lines and areas ───────────────────────────────────────────────────────

export function LineChart(props: {
  labels: readonly string[]
  series: readonly (Series | null)[]
  format?: Format | null
  area?: boolean | null
  stacked?: boolean | null
}) {
  const size = createWidth()
  const gradient = createUniqueId()
  const [hovered, setHovered] = createSignal<number>()
  const [focus, setFocus] = createSignal<number>()
  const series = createMemo(() => present(props.series))
  const format = () => props.format ?? "compact"
  const count = () => props.labels.length
  const plot = () => HEIGHT - PAD.top - PAD.bottom
  const right = () => size.width() - PAD.right

  const x = (index: number) =>
    count() <= 1 ? (PAD.left + right()) / 2 : PAD.left + (index / (count() - 1)) * (right() - PAD.left)
  // Stacked areas draw each series on top of the ones before it.

  const stackedValues = createMemo(() =>
    series().map((item, seriesIndex) =>
      item.values.map((value, index) =>
        value === null
          ? null
          : props.stacked
            ? series()
                .slice(0, seriesIndex + 1)
                .reduce((sum, other) => sum + (other.values[index] ?? 0), 0)
            : value,
      ),
    ),
  )

  const max = createMemo(() => niceMax(Math.max(0, ...stackedValues().map((values) => maxOf(values))), format()))
  const y = (value: number) => PAD.top + plot() - (value / max()) * plot()
  const baseline = () => PAD.top + plot()
  const colors = () => series().map((_, index) => seriesColor(index, series().length))

  const points = (seriesIndex: number) =>
    (stackedValues()[seriesIndex] ?? []).map((value, index) => (value === null ? null : { x: x(index), y: y(value) }))

  const shaded = () => props.area === true || props.stacked === true
  const dim = (seriesIndex: number) => (focus() !== undefined && focus() !== seriesIndex ? 0.25 : 1)

  const bounds = () => ({ top: PAD.top, bottom: baseline() })

  const move = (event: MouseEvent & { currentTarget: SVGRectElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const ratio = (event.clientX - bounds.left) / Math.max(1, bounds.width)

    setHovered(Math.max(0, Math.min(count() - 1, Math.round(ratio * (count() - 1)))))
  }

  return (
    <Frame
      label={series()
        .map((item) => item.name)
        .join(", ")}
      legend={<Legend names={series().map((item) => item.name)} colors={colors()} onHover={setFocus} />}
    >
      <div data-slot="genui-chart-plot" ref={size.ref} onMouseLeave={() => setHovered(undefined)}>
        <Show when={size.width() > 0}>
          <svg width={size.width()} height={HEIGHT} role="img">
            <defs>
              <Index each={series()}>
                {(_, seriesIndex) => (
                  <linearGradient id={`${gradient}-${seriesIndex}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stop-color={colors()[seriesIndex]} stop-opacity={props.stacked ? 0.22 : 0.1} />
                    <stop offset="66%" stop-color={colors()[seriesIndex]} stop-opacity={props.stacked ? 0.16 : 0.045} />
                    <stop offset="100%" stop-color={colors()[seriesIndex]} stop-opacity={props.stacked ? 0.1 : 0} />
                  </linearGradient>
                )}
              </Index>
            </defs>
            <Grid width={size.width()} max={max()} format={format()} />
            <For each={[...series().keys()].toReversed()}>
              {(seriesIndex) => {
                const path = () => smoothPath(points(seriesIndex), bounds())

                // A stacked layer fills down to the layer beneath it; any other area fills to the baseline.
                const filled = () => {
                  const run = points(seriesIndex).flatMap((point) => (point ? [point] : []))
                  const first = run[0]
                  const last = run.at(-1)

                  if (!first || !last) return ""

                  if (props.stacked && seriesIndex > 0)
                    return `${path()}${smoothPath(points(seriesIndex - 1).toReversed(), bounds()).replace(/^M/u, "L")}Z`

                  return `${path()}L${last.x},${baseline()}L${first.x},${baseline()}Z`
                }

                const end = () => points(seriesIndex).findLast((point) => point !== null)

                return (
                  <g opacity={dim(seriesIndex)} data-slot="genui-chart-series">
                    <Show when={shaded()}>
                      <path d={filled()} fill={`url(#${gradient}-${seriesIndex})`} />
                    </Show>
                    <path d={path()} stroke={colors()[seriesIndex]} data-slot="genui-chart-line" />
                    <Show when={hovered() === undefined ? end() : undefined}>
                      {(point) => (
                        <rect x={point().x - 3} y={point().y - 3} width={6} height={6} fill={colors()[seriesIndex]} />
                      )}
                    </Show>
                  </g>
                )
              }}
            </For>
            <Show when={hovered()} keyed>
              {(index) => (
                <g>
                  <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={baseline()} data-slot="genui-chart-guide" />
                  <Index each={series()}>
                    {(_, seriesIndex) => (
                      <Show when={points(seriesIndex)[index]}>
                        {(point) => (
                          <circle
                            cx={point().x}
                            cy={point().y}
                            r={3.5}
                            stroke={colors()[seriesIndex]}
                            data-slot="genui-chart-dot"
                          />
                        )}
                      </Show>
                    )}
                  </Index>
                </g>
              )}
            </Show>
            <rect
              x={PAD.left}
              y={0}
              width={Math.max(0, right() - PAD.left)}
              height={baseline()}
              fill="transparent"
              onMouseMove={move}
            />
            <XLabels labels={props.labels} x={x} left={PAD.left} right={right()} />
          </svg>
          <Show when={hovered()} keyed>
            {(index) => (
              <Tooltip
                x={x(index)}
                width={size.width()}
                title={props.labels[index] ?? ""}
                rows={series().flatMap((item, seriesIndex) => {
                  const value = item.values[index]

                  return value === null || value === undefined
                    ? []
                    : [
                        {
                          color: series().length > 1 ? colors()[seriesIndex] : undefined,
                          name: series().length > 1 ? item.name : undefined,
                          value: formatValue(value, format()),
                        },
                      ]
                })}
              />
            )}
          </Show>
        </Show>
      </div>
    </Frame>
  )
}

// ─── Bars and a line on two scales ─────────────────────────────────────────

export function ComboChart(props: {
  labels: readonly string[]
  bars: Series | null
  line: Series | null
  barFormat?: Format | null
  lineFormat?: Format | null
}) {
  const size = createWidth()
  const [hovered, setHovered] = createSignal<number>()
  const count = () => Math.max(1, props.labels.length)
  const plot = () => HEIGHT - PAD.top - PAD.bottom
  const right = () => size.width() - PAD.left
  const slot = () => Math.max(0, right() - PAD.left) / count()
  const center = (index: number) => PAD.left + slot() * (index + 0.5)
  const barMax = createMemo(() => niceMax(maxOf(props.bars?.values ?? []), props.barFormat ?? undefined))
  const lineMax = createMemo(() => niceMax(maxOf(props.line?.values ?? []), props.lineFormat ?? undefined))
  const baseline = () => PAD.top + plot()
  const barWidth = () => Math.max(2, Math.min(36, slot() * (2 / 3)))

  const points = () =>
    (props.line?.values ?? []).map((value, index) =>
      value === null ? null : { x: center(index), y: PAD.top + plot() - (value / lineMax()) * plot() },
    )

  return (
    <Frame
      label={[props.bars?.name, props.line?.name].filter((name) => name !== undefined).join(", ")}
      legend={
        <Legend
          names={[props.bars?.name ?? "", props.line?.name ?? ""]}
          colors={["var(--genui-bar)", "var(--genui-ink)"]}
          onHover={() => undefined}
        />
      }
    >
      <div data-slot="genui-chart-plot" ref={size.ref} onMouseLeave={() => setHovered(undefined)}>
        <Show when={size.width() > 0}>
          <svg width={size.width()} height={HEIGHT} role="img">
            <Show when={hovered() !== undefined}>
              <Highlight x={PAD.left + slot() * (hovered() ?? 0)} width={slot()} />
            </Show>
            <Grid
              width={size.width()}
              max={barMax()}
              format={props.barFormat ?? "compact"}
              right={{ max: lineMax(), format: props.lineFormat ?? "compact" }}
            />
            <Index each={props.labels}>
              {(_, index) => {
                const value = () => props.bars?.values[index] ?? 0
                const h = () => (value() > 0 ? Math.max(2, (value() / barMax()) * plot()) : 0)

                return (
                  <g>
                    <rect
                      x={center(index) - barWidth() / 2}
                      y={baseline() - h()}
                      width={barWidth()}
                      height={h()}
                      fill={hovered() === index ? "var(--genui-series-1)" : "var(--genui-bar)"}
                      opacity={hovered() !== undefined && hovered() !== index ? 0.64 : 1}
                      data-slot="genui-chart-bar"
                    />
                    <rect
                      x={PAD.left + slot() * index}
                      y={0}
                      width={slot()}
                      height={baseline()}
                      fill="transparent"
                      onMouseEnter={() => setHovered(index)}
                    />
                  </g>
                )
              }}
            </Index>
            <path
              d={smoothPath(points(), { top: PAD.top, bottom: baseline() })}
              stroke="var(--genui-ink)"
              data-slot="genui-chart-line"
              style={{ "pointer-events": "none" }}
            />
            <Show when={hovered() === undefined ? points().findLast((point) => point !== null) : undefined}>
              {(point) => <rect x={point().x - 3} y={point().y - 3} width={6} height={6} fill="var(--genui-ink)" />}
            </Show>
            <Show when={hovered() !== undefined ? points()[hovered() ?? 0] : undefined}>
              {(point) => (
                <circle cx={point().x} cy={point().y} r={3.5} stroke="var(--genui-ink)" data-slot="genui-chart-dot" />
              )}
            </Show>
            <XLabels labels={props.labels} x={center} left={PAD.left} right={right()} />
          </svg>
          <Show when={hovered()} keyed>
            {(index) => (
              <Tooltip
                x={center(index)}
                width={size.width()}
                title={props.labels[index] ?? ""}
                rows={[
                  {
                    color: "var(--genui-series-1)",
                    name: props.bars?.name ?? "",
                    value: formatValue(props.bars?.values[index] ?? 0, props.barFormat ?? "compact"),
                  },
                  {
                    color: "var(--genui-ink)",
                    name: props.line?.name ?? "",
                    value: formatValue(props.line?.values[index] ?? 0, props.lineFormat ?? "compact"),
                  },
                ]}
              />
            )}
          </Show>
        </Show>
      </div>
    </Frame>
  )
}

// ─── Actual plus projection ────────────────────────────────────────────────

export function ProjectionChart(props: {
  labels: readonly string[]
  actual: readonly (number | null)[]
  projected: readonly (number | null)[]
  target?: number | null
  format?: Format | null
  targetLabel?: string | null
}) {
  const i18n = useI18n()
  const size = createWidth()
  const area = createUniqueId()
  const hatch = createUniqueId()
  const [hovered, setHovered] = createSignal<number>()
  const format = () => props.format ?? "compact"
  const count = () => props.labels.length
  const plot = () => HEIGHT - PAD.top - PAD.bottom
  const right = () => size.width() - PAD.right
  const x = (index: number) => (count() <= 1 ? PAD.left : PAD.left + (index / (count() - 1)) * (right() - PAD.left))

  const max = createMemo(() =>
    niceMax(Math.max(maxOf(props.actual), maxOf(props.projected), props.target ?? 0), format()),
  )

  const y = (value: number) => PAD.top + plot() - (value / max()) * plot()
  const baseline = () => PAD.top + plot()
  const now = () => props.actual.findLastIndex((value) => value !== null)
  const actual = () => props.actual.map((value, index) => (value === null ? null : { x: x(index), y: y(value) }))
  // The projection starts where the actual series ends, so the two lines meet.

  const projected = () =>
    props.projected.map((value, index) => {
      const joined = index === now() ? (props.actual[index] ?? value) : value

      return joined === null || joined === undefined ? null : { x: x(index), y: y(joined) }
    })

  const crossing = createMemo(() => {
    const target = props.target

    if (target === undefined || target === null) return undefined
    const values = props.projected.map((value, index) => (index === now() ? (props.actual[index] ?? value) : value))

    const index = values.findIndex(
      (value, at) => at > 0 && value !== null && value >= target && (values[at - 1] ?? Infinity) < target,
    )

    if (index <= 0) return undefined
    const before = values[index - 1] ?? 0
    const after = values[index] ?? 0

    return x(index - 1) + ((target - before) / Math.max(1e-9, after - before)) * (x(index) - x(index - 1))
  })

  const end = () => projected().findLast((point) => point !== null)
  const nowPoint = () => actual()[now()]

  const filled = (points: readonly ({ x: number; y: number } | null)[]) => {
    const run = points.flatMap((point) => (point ? [point] : []))
    const first = run[0]
    const last = run.at(-1)

    return first && last ? `${smoothPath(points)}L${last.x},${baseline()}L${first.x},${baseline()}Z` : ""
  }

  const move = (event: MouseEvent & { currentTarget: SVGRectElement }) => {
    const bounds = event.currentTarget.getBoundingClientRect()

    setHovered(
      Math.max(
        0,
        Math.min(count() - 1, Math.round(((event.clientX - bounds.left) / Math.max(1, bounds.width)) * (count() - 1))),
      ),
    )
  }

  return (
    <Frame
      label="Projection"
      legend={
        <div data-slot="genui-chart-legend">
          <span>
            <i style={{ background: "var(--v2-state-fg-success)" }} />
            {i18n.t("ui.genui.actual")}
          </span>
          <span>
            <i style={{ background: "var(--v2-state-fg-warning)" }} />
            {i18n.t("ui.genui.projected")}
          </span>
          <Show when={props.target !== undefined && props.target !== null}>
            <span>
              <i data-slot="genui-chart-limit-swatch" />
              {props.targetLabel ?? i18n.t("ui.genui.target")}
            </span>
          </Show>
        </div>
      }
    >
      <div data-slot="genui-chart-plot" ref={size.ref} onMouseLeave={() => setHovered(undefined)}>
        <Show when={size.width() > 0}>
          <svg width={size.width()} height={HEIGHT} role="img">
            <defs>
              <linearGradient id={area} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="var(--v2-state-fg-success)" stop-opacity="0.08" />
                <stop offset="100%" stop-color="var(--v2-state-fg-success)" stop-opacity="0" />
              </linearGradient>
              <pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="2" height="6" fill="var(--v2-state-fg-warning)" opacity="0.1" />
              </pattern>
            </defs>
            <Grid width={size.width()} max={max()} format={format()} />
            <path d={filled(projected())} fill={`url(#${hatch})`} />
            <path d={filled(actual())} fill={`url(#${area})`} />
            <Show when={props.target ?? undefined}>
              {(target) => (
                <g>
                  <line x1={PAD.left} x2={right()} y1={y(target())} y2={y(target())} data-slot="genui-chart-limit" />
                  <text x={right()} y={y(target()) - 6} text-anchor="end" data-slot="genui-chart-label">
                    {`${props.targetLabel ?? i18n.t("ui.genui.target")} ${formatValue(target(), format())}`}
                  </text>
                </g>
              )}
            </Show>
            <Show when={nowPoint()}>
              {(point) => (
                <line x1={point().x} x2={point().x} y1={PAD.top} y2={baseline()} data-slot="genui-chart-guide" />
              )}
            </Show>
            <Show when={crossing()}>
              {(at) => <line x1={at()} x2={at()} y1={PAD.top} y2={baseline()} data-slot="genui-chart-guide" />}
            </Show>
            <path
              d={smoothPath(projected(), { top: PAD.top, bottom: baseline() })}
              stroke="var(--v2-state-fg-warning)"
              data-slot="genui-chart-line"
            />
            <path
              d={smoothPath(actual(), { top: PAD.top, bottom: baseline() })}
              stroke="var(--v2-state-fg-success)"
              data-slot="genui-chart-line"
            />
            <Show when={nowPoint()}>
              {(point) => (
                <circle
                  cx={point().x}
                  cy={point().y}
                  r={3.5}
                  stroke="var(--v2-state-fg-success)"
                  data-slot="genui-chart-glow"
                />
              )}
            </Show>
            <Show when={end()}>
              {(point) => (
                <circle
                  cx={point().x}
                  cy={point().y}
                  r={3.5}
                  stroke="var(--v2-state-fg-warning)"
                  data-slot="genui-chart-glow"
                />
              )}
            </Show>
            <Show when={crossing() !== undefined && props.target !== undefined && props.target !== null}>
              <circle
                cx={crossing() ?? 0}
                cy={y(props.target ?? 0)}
                r={3.5}
                stroke="var(--v2-state-fg-warning)"
                data-slot="genui-chart-glow"
              />
            </Show>
            <Show when={hovered()} keyed>
              {(index) => (
                <line x1={x(index)} x2={x(index)} y1={PAD.top} y2={baseline()} data-slot="genui-chart-guide" />
              )}
            </Show>
            <rect
              x={PAD.left}
              y={0}
              width={Math.max(0, right() - PAD.left)}
              height={baseline()}
              fill="transparent"
              onMouseMove={move}
            />
            <XLabels labels={props.labels} x={x} left={PAD.left} right={right()} />
          </svg>
          <Show when={hovered()} keyed>
            {(index) => (
              <Tooltip
                x={x(index)}
                width={size.width()}
                title={props.labels[index] ?? ""}
                rows={[
                  ...(props.actual[index] !== null && props.actual[index] !== undefined
                    ? [
                        {
                          color: "var(--v2-state-fg-success)",
                          name: i18n.t("ui.genui.actual"),
                          value: formatValue(props.actual[index] ?? 0, format()),
                        },
                      ]
                    : []),
                  ...(props.projected[index] !== null && props.projected[index] !== undefined && index !== now()
                    ? [
                        {
                          color: "var(--v2-state-fg-warning)",
                          name: i18n.t("ui.genui.projected"),
                          value: formatValue(props.projected[index] ?? 0, format()),
                        },
                      ]
                    : []),
                ]}
              />
            )}
          </Show>
        </Show>
      </div>
    </Frame>
  )
}

// ─── Parts of a whole ──────────────────────────────────────────────────────

export function DonutChart(props: { items: readonly Item[]; center?: string | null; format?: Format | null }) {
  const i18n = useI18n()
  const [hovered, setHovered] = createSignal<number>()
  const total = () => props.items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  const colors = () => props.items.map((_, index) => seriesColor(index, Math.max(2, props.items.length)))
  const gap = () => (props.items.length > 1 ? 0.006 : 0)

  const segments = createMemo(() => {
    const sizes = props.items.map((item) => (total() > 0 ? Math.max(0, item.value) / total() : 0))

    return sizes.map((size, index) => ({ start: sizes.slice(0, index).reduce((sum, value) => sum + value, 0), size }))
  })

  const share = (value: number) => formatValue(total() > 0 ? (value / total()) * 100 : 0, "percent")

  return (
    <figure data-component="genui-donut" aria-label="Share">
      <div data-slot="genui-donut-figure">
        {/* The console's summary card order: label, then figure. Above the ring, so long values never collide. */}
        <div data-slot="genui-donut-summary">
          <span>{hovered() !== undefined ? (props.items[hovered() ?? 0]?.label ?? "") : i18n.t("ui.genui.total")}</span>
          <b>
            {hovered() !== undefined
              ? share(props.items[hovered() ?? 0]?.value ?? 0)
              : (props.center ?? formatValue(total(), props.format ?? "compact"))}
          </b>
        </div>
        <svg viewBox="0 0 120 120" width="132" height="132" role="img">
          <circle cx="60" cy="60" r="48" data-slot="genui-donut-track" />
          <Index each={segments()}>
            {(segment, index) => (
              <circle
                cx="60"
                cy="60"
                r="48"
                pathLength="1"
                stroke={colors()[index]}
                stroke-dasharray={`${Math.max(0, segment().size - gap())} ${1 - Math.max(0, segment().size - gap())}`}
                stroke-dashoffset={-segment().start}
                transform="rotate(-90 60 60)"
                opacity={hovered() !== undefined && hovered() !== index ? 0.25 : 1}
                data-slot="genui-donut-segment"
                onMouseEnter={() => setHovered(index)}
                onMouseLeave={() => setHovered(undefined)}
              />
            )}
          </Index>
        </svg>
      </div>
      <div data-slot="genui-donut-legend">
        <Index each={props.items}>
          {(item, index) => (
            <div
              data-slot="genui-donut-row"
              data-dim={hovered() !== undefined && hovered() !== index ? "" : undefined}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(undefined)}
            >
              <i style={{ background: colors()[index] }} />
              <span>{item().label}</span>
              <em>{formatValue(item().value, props.format ?? "compact")}</em>
              <b>{share(item().value)}</b>
            </div>
          )}
        </Index>
      </div>
    </figure>
  )
}

export function ShareBar(props: { items: readonly Item[]; format?: Format | null }) {
  const [hovered, setHovered] = createSignal<number>()
  const total = () => props.items.reduce((sum, item) => sum + Math.max(0, item.value), 0)
  const colors = () => props.items.map((_, index) => seriesColor(index, Math.max(2, props.items.length)))
  const share = (value: number) => formatValue(total() > 0 ? (value / total()) * 100 : 0, "percent")

  return (
    <figure data-component="genui-share" aria-label="Share">
      <div data-slot="genui-share-bar">
        <Index each={props.items}>
          {(item, index) => (
            <span
              style={{ "flex-grow": Math.max(0, item().value), background: colors()[index] }}
              data-dim={hovered() !== undefined && hovered() !== index ? "" : undefined}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(undefined)}
            />
          )}
        </Index>
      </div>
      <div data-slot="genui-share-legend">
        <Index each={props.items}>
          {(item, index) => (
            <span
              data-dim={hovered() !== undefined && hovered() !== index ? "" : undefined}
              onMouseEnter={() => setHovered(index)}
              onMouseLeave={() => setHovered(undefined)}
            >
              <i style={{ background: colors()[index] }} />
              {item().label}
              <b>{share(item().value)}</b>
              <em>{formatValue(item().value, props.format ?? "compact")}</em>
            </span>
          )}
        </Index>
      </div>
    </figure>
  )
}

// ─── Meters ────────────────────────────────────────────────────────────────

/** The console's allowance meter: a glossy fill and the remaining track, 8px tall with a 4px gap. */
export function Meter(props: { label: string; value: number; detail?: string | null; tone?: Tone | "auto" | null }) {
  const value = () => Math.min(100, Math.max(0, props.value))

  const tone = (): Tone =>
    props.tone === "auto"
      ? value() > 95
        ? "danger"
        : value() >= 70
          ? "warning"
          : "success"
      : (props.tone ?? "neutral")

  return (
    <div
      data-component="genui-meter"
      role="meter"
      aria-label={props.label}
      aria-valuenow={value()}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div data-slot="genui-progress-heading">
        <span data-slot="genui-row-label">{props.label}</span>
        <span data-slot="genui-row-value">{props.detail ?? formatValue(value(), "percent")}</span>
      </div>
      <div data-slot="genui-meter-bar">
        <Show when={value() > 0}>
          <span data-slot="genui-meter-fill" style={{ flex: `${value()} 1 0%`, background: toneColor(tone()) }} />
        </Show>
        <Show when={value() < 100}>
          <span data-slot="genui-meter-rest" style={{ flex: `${100 - value()} 1 0%` }} />
        </Show>
      </div>
    </div>
  )
}

/** The stats site's ratio marker: a track ruled every 20% and a thumb at the value. */
export function Gauge(props: { label: string; value: number; detail?: string | null }) {
  const value = () => Math.min(100, Math.max(0, props.value))

  return (
    <div
      data-component="genui-gauge"
      role="meter"
      aria-label={props.label}
      aria-valuenow={value()}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div data-slot="genui-progress-heading">
        <span data-slot="genui-row-label">{props.label}</span>
        <span data-slot="genui-row-value">{props.detail ?? formatValue(value(), "percent")}</span>
      </div>
      <div data-slot="genui-gauge-track">
        <i style={{ left: `${value()}%` }} />
      </div>
      <div data-slot="genui-gauge-scale">
        <span>0</span>
        <span>50</span>
        <span>100</span>
      </div>
    </div>
  )
}

/** Twenty pips for a 0–100 score, in a compact pill. */
export function Pips(props: { label: string; value: number; detail?: string | null; tone?: Tone | null }) {
  const active = () => (props.value <= 0 ? 0 : Math.max(1, Math.min(20, Math.round(props.value / 5))))

  return (
    <div
      data-component="genui-pips"
      role="meter"
      aria-label={props.label}
      aria-valuenow={props.value}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span data-slot="genui-row-label">{props.label}</span>
      <span data-slot="genui-pips-pill">
        <Index each={Array.from({ length: 20 })}>
          {(_, index) => (
            <i style={index < active() ? { background: toneColor(props.tone ?? undefined) } : undefined} />
          )}
        </Index>
      </span>
      <span data-slot="genui-row-value">{props.detail ?? formatValue(props.value, "number")}</span>
    </div>
  )
}

/** The console's status timeline: one soft-tinted block per check, oldest first. */
export function StatusStrip(props: {
  items: readonly { label: string; tone: Tone }[]
  start?: string | null
  end?: string | null
}) {
  const [hovered, setHovered] = createSignal<number>()

  return (
    <figure data-component="genui-strip" aria-label="Status timeline">
      <div data-slot="genui-strip-blocks" onMouseLeave={() => setHovered(undefined)}>
        <Index each={props.items}>
          {(item, index) => (
            <span
              data-tone={item().tone}
              data-active={hovered() === index ? "" : undefined}
              onMouseEnter={() => setHovered(index)}
            />
          )}
        </Index>
      </div>
      <div data-slot="genui-strip-footer">
        <span>{props.start ?? ""}</span>
        <span data-slot="genui-strip-current">
          {hovered() !== undefined ? (props.items[hovered() ?? 0]?.label ?? "") : ""}
        </span>
        <span>{props.end ?? ""}</span>
      </div>
    </figure>
  )
}

// ─── Grids, radar and scatter ──────────────────────────────────────────────

export function Heatmap(props: {
  rows: readonly string[]
  columns: readonly string[]
  values: readonly (readonly (number | null)[])[]
  format?: Format | null
}) {
  const i18n = useI18n()
  const [hovered, setHovered] = createSignal<{ row: number; column: number }>()
  const max = () => Math.max(0, ...props.values.map((row) => maxOf(row)))

  const shown = createMemo(
    () =>
      new Set(
        labelIndexes(props.columns.length).concat(
          props.columns.length <= 12 ? props.columns.map((_, index) => index) : [],
        ),
      ),
  )
  // Square-root intensity, as the stats site's geo list, so small values stay visible.

  const fill = (value: number | null) =>
    value === null || value <= 0 || max() <= 0
      ? "var(--v2-background-bg-layer-02)"
      : `color-mix(in oklch, var(--genui-ink) ${Math.round(8 + Math.sqrt(value / max()) * 60)}%, transparent)`

  return (
    <figure
      data-component="genui-heatmap"
      aria-label="Heatmap"
      style={{ "--genui-heatmap-columns": props.columns.length }}
    >
      <div data-slot="genui-heatmap-grid" onMouseLeave={() => setHovered(undefined)}>
        <span />
        <Index each={props.columns}>
          {(column, index) => <span data-slot="genui-heatmap-column">{shown().has(index) ? column() : ""}</span>}
        </Index>
        <Index each={props.rows}>
          {(row, rowIndex) => (
            <>
              <span data-slot="genui-heatmap-row">{row()}</span>
              <Index each={props.columns}>
                {(_, column) => {
                  const value = () => props.values[rowIndex]?.[column] ?? null

                  return (
                    <i
                      style={{ background: fill(value()) }}
                      data-active={hovered()?.row === rowIndex && hovered()?.column === column ? "" : undefined}
                      onMouseEnter={() => setHovered({ row: rowIndex, column })}
                    />
                  )
                }}
              </Index>
            </>
          )}
        </Index>
      </div>
      <div data-slot="genui-heatmap-footer">
        <span>
          {hovered()
            ? `${props.rows[hovered()?.row ?? 0] ?? ""} · ${props.columns[hovered()?.column ?? 0] ?? ""} · ${formatValue(props.values[hovered()?.row ?? 0]?.[hovered()?.column ?? 0] ?? 0, props.format ?? "compact")}`
            : ""}
        </span>
        <span data-slot="genui-heatmap-scale">
          {i18n.t("ui.genui.less")}
          <For each={[0, 0.25, 0.5, 0.75, 1]}>{(step) => <i style={{ background: fill(step * max()) }} />}</For>
          {i18n.t("ui.genui.more")}
        </span>
      </div>
    </figure>
  )
}

export function RadarChart(props: { axes: readonly string[]; series: readonly (Series | null)[] }) {
  const size = createWidth()
  const [focus, setFocus] = createSignal<number>()
  const series = createMemo(() => present(props.series))
  const side = () => Math.min(size.width(), 340)
  const radius = () => Math.max(0, side() / 2 - 44)
  const center = () => ({ x: size.width() / 2, y: side() / 2 })
  const angle = (index: number) => -Math.PI / 2 + (index * 2 * Math.PI) / Math.max(1, props.axes.length)

  const point = (index: number, score: number) => ({
    x: center().x + Math.cos(angle(index)) * radius() * (Math.min(100, Math.max(0, score)) / 100),
    y: center().y + Math.sin(angle(index)) * radius() * (Math.min(100, Math.max(0, score)) / 100),
  })

  const polygon = (score: (index: number) => number) =>
    props.axes
      .map((_, index) => point(index, score(index)))
      .map((p) => `${p.x},${p.y}`)
      .join(" ")

  const colors = () => series().map((_, index) => seriesColor(index, series().length))

  return (
    <Frame
      label="Radar"
      legend={<Legend names={series().map((item) => item.name)} colors={colors()} onHover={setFocus} />}
    >
      <div data-slot="genui-chart-plot" ref={size.ref}>
        <Show when={size.width() > 0}>
          <svg width={size.width()} height={side()} role="img">
            <For each={[20, 40, 60, 80, 100]}>
              {(ring) => <polygon points={polygon(() => ring)} data-slot="genui-chart-ring" />}
            </For>
            <Index each={props.axes}>
              {(axis, index) => {
                const end = () => point(index, 100)
                const label = () => point(index, 118)
                const cos = () => Math.cos(angle(index))

                return (
                  <g>
                    <line x1={center().x} y1={center().y} x2={end().x} y2={end().y} data-slot="genui-chart-ring" />
                    <text
                      x={label().x}
                      y={label().y + 3.5}
                      text-anchor={cos() > 0.25 ? "start" : cos() < -0.25 ? "end" : "middle"}
                      data-slot="genui-chart-axis"
                    >
                      {axis()}
                    </text>
                  </g>
                )
              }}
            </Index>
            <Index each={series()}>
              {(item, seriesIndex) => (
                <g
                  style={{ color: colors()[seriesIndex] }}
                  opacity={focus() !== undefined && focus() !== seriesIndex ? 0.2 : 1}
                  data-slot="genui-chart-series"
                  onMouseEnter={() => setFocus(seriesIndex)}
                  onMouseLeave={() => setFocus(undefined)}
                >
                  <polygon points={polygon((index) => item().values[index] ?? 0)} data-slot="genui-radar-area" />
                  <Index each={props.axes}>
                    {(_, index) => {
                      const p = () => point(index, item().values[index] ?? 0)

                      return <circle cx={p().x} cy={p().y} r={2.5} fill="currentColor" />
                    }}
                  </Index>
                </g>
              )}
            </Index>
          </svg>
        </Show>
      </div>
    </Frame>
  )
}

export function ScatterChart(props: {
  points: readonly { label: string; x: number; y: number }[]
  xLabel: string
  yLabel: string
  xFormat?: Format | null
  yFormat?: Format | null
}) {
  const size = createWidth()
  const [hovered, setHovered] = createSignal<number>()
  const plot = () => HEIGHT - PAD.top - PAD.bottom
  const right = () => size.width() - PAD.right - 8
  const xMax = createMemo(() => niceMax(Math.max(0, ...props.points.map((p) => p.x)), props.xFormat ?? undefined))
  const yMax = createMemo(() => niceMax(Math.max(0, ...props.points.map((p) => p.y)), props.yFormat ?? undefined))
  const px = (value: number) => PAD.left + (value / xMax()) * (right() - PAD.left)
  const py = (value: number) => PAD.top + plot() - (value / yMax()) * plot()
  const labelled = () => props.points.length <= 10

  return (
    <Frame label={`${props.yLabel} by ${props.xLabel}`}>
      <div data-slot="genui-chart-plot" ref={size.ref}>
        <Show when={size.width() > 0}>
          <svg width={size.width()} height={HEIGHT} role="img">
            <Grid width={size.width()} max={yMax()} format={props.yFormat ?? "compact"} />
            <For each={[1, 2, 3]}>
              {(step) => (
                <line
                  x1={px((xMax() * step) / 3)}
                  x2={px((xMax() * step) / 3)}
                  y1={PAD.top}
                  y2={PAD.top + plot()}
                  data-slot="genui-chart-grid"
                  stroke-dasharray="4 3"
                />
              )}
            </For>
            <For each={[0, 1, 2, 3]}>
              {(step) => (
                <text
                  x={px((xMax() * step) / 3)}
                  y={HEIGHT - 6}
                  text-anchor={edgeAnchor(step, 3)}
                  data-slot="genui-chart-label"
                >
                  {formatValue((xMax() * step) / 3, props.xFormat ?? "compact")}
                </text>
              )}
            </For>
            <text x={PAD.left + 4} y={PAD.top + 10} data-slot="genui-chart-axis">
              {props.yLabel}
            </text>
            <text x={right()} y={PAD.top + plot() - 6} text-anchor="end" data-slot="genui-chart-axis">
              {props.xLabel}
            </text>
            <Index each={props.points}>
              {(p, index) => (
                <g onMouseEnter={() => setHovered(index)} onMouseLeave={() => setHovered(undefined)}>
                  <circle
                    cx={px(p().x)}
                    cy={py(p().y)}
                    r={hovered() === index ? 5 : 4}
                    fill="var(--genui-ink)"
                    opacity={hovered() === undefined ? 0.6 : hovered() === index ? 1 : 0.25}
                    data-slot="genui-chart-point"
                  />
                  <Show when={labelled()}>
                    <text x={px(p().x) + 8} y={py(p().y) + 3.5} data-slot="genui-chart-point-label">
                      {p().label}
                    </text>
                  </Show>
                  <circle cx={px(p().x)} cy={py(p().y)} r={10} fill="transparent" />
                </g>
              )}
            </Index>
          </svg>
          <Show when={hovered()} keyed>
            {(index) => {
              const p = props.points[index]

              return (
                <Show when={p}>
                  {(point) => (
                    <Tooltip
                      x={px(point().x)}
                      width={size.width()}
                      title={point().label}
                      rows={[
                        { name: props.xLabel, value: formatValue(point().x, props.xFormat ?? "compact") },
                        { name: props.yLabel, value: formatValue(point().y, props.yFormat ?? "compact") },
                      ]}
                    />
                  )}
                </Show>
              )
            }}
          </Show>
        </Show>
      </div>
    </Frame>
  )
}

// ─── Comparison and metric parts ───────────────────────────────────────────

export function Comparison(props: {
  columns: readonly string[]
  rows: readonly ({ label: string; values: readonly (string | number)[]; best?: "higher" | "lower" | null } | null)[]
}) {
  // The best cell is the unique highest or lowest number among at least two numbers in the row.
  const best = (row: { values: readonly (string | number)[]; best?: "higher" | "lower" | null }) => {
    const numbers = row.values.flatMap((value, index) =>
      Number.isFinite(value) ? [{ value: Number(value), index }] : [],
    )

    if (!row.best || numbers.length < 2) return -1

    const target =
      row.best === "higher" ? Math.max(...numbers.map((n) => n.value)) : Math.min(...numbers.map((n) => n.value))

    const winners = numbers.filter((n) => n.value === target)

    return winners.length === 1 ? (winners[0]?.index ?? -1) : -1
  }

  return (
    <div data-component="genui-table" data-variant="comparison">
      <table>
        <thead>
          <tr>
            <th />
            <For each={props.columns}>{(column) => <th>{column}</th>}</For>
          </tr>
        </thead>
        <tbody>
          <For each={props.rows.flatMap((row) => (row ? [row] : []))}>
            {(row) => (
              <tr>
                <th scope="row">{row.label}</th>
                <For each={row.values}>
                  {(value, index) => (
                    <td
                      data-numeric={Number.isFinite(value) || undefined}
                      data-best={best(row) === index() ? "" : undefined}
                    >
                      {String(value)}
                    </td>
                  )}
                </For>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  )
}

/** A percent change chip: green for good, red for bad, with the sign spelled out. */
export function Delta(props: { value: number; inverse?: boolean | null }) {
  const tone = () =>
    props.value === 0 ? "neutral" : props.value > 0 !== (props.inverse === true) ? "success" : "danger"

  return (
    <span data-slot="genui-delta" data-tone={tone()}>
      {`${props.value > 0 ? "+" : props.value < 0 ? "−" : ""}${trim(Math.abs(props.value), Math.abs(props.value) < 10 ? 1 : 0)}%`}
    </span>
  )
}

/** The stats site's inline sparkline: a soft area and a 1.5px line, colored by the metric's direction. */
export function Sparkline(props: { values: readonly number[]; tone?: Tone }) {
  const id = createUniqueId()
  const width = 64
  const height = 24

  const points = () => {
    const min = Math.min(...props.values)
    const max = Math.max(...props.values)

    return props.values.map((value, index) => ({
      x: props.values.length <= 1 ? width / 2 : 1 + (index / (props.values.length - 1)) * (width - 2),
      y: max === min ? height / 2 : height - 3 - ((value - min) / (max - min)) * (height - 6),
    }))
  }

  const color = () => toneColor(props.tone)

  return (
    <Show when={props.values.length > 1}>
      <svg
        data-slot="genui-sparkline"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color={color()} stop-opacity="0.16" />
            <stop offset="100%" stop-color={color()} stop-opacity="0" />
          </linearGradient>
        </defs>
        <path
          d={`${smoothPath(points())}L${points().at(-1)?.x ?? 0},${height}L${points()[0]?.x ?? 0},${height}Z`}
          fill={`url(#${id})`}
        />
        <path d={smoothPath(points())} stroke={color()} data-slot="genui-chart-line" />
      </svg>
    </Show>
  )
}
