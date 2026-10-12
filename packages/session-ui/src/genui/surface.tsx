import { createContext, createMemo, createRenderEffect, For, Show, useContext, type JSX } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { GenUICatalog } from "@opencode/plugin-genui/catalog"
import { GenUI } from "@opencode/plugin-genui/genui"
import { GenUILang } from "@opencode/plugin-genui/lang"
import { Button, type ButtonProps } from "@opencode/ui/button"
import { Divider } from "@opencode/ui/divider"
import { Icon } from "@opencode/ui/icon"
import type { IconName } from "@opencode/ui/icons/catalog"
import { RadioGroup, RadioItem } from "@opencode/ui/radio"
import { SegmentedControl, SegmentedControlItem } from "@opencode/ui/segmented-control"
import { Select } from "@opencode/ui/select"
import { Switch } from "@opencode/ui/switch"
import { TextInput } from "@opencode/ui/text-input"
import { Textarea } from "@opencode/ui/textarea"
import { Markdown } from "../components/markdown"
import {
  BarChart,
  ComboChart,
  Comparison,
  Delta,
  DonutChart,
  Gauge,
  Heatmap,
  LineChart,
  Meter,
  Pips,
  ProjectionChart,
  RadarChart,
  ScatterChart,
  ShareBar,
  Sparkline,
  StatusStrip,
} from "./charts"

/** What a surface sends back when the user presses a button, a clickable row, or submits a form. */
export type GenUIReply = {
  readonly message: string
  /** Submitted form fields, by label, in form order. */
  readonly values?: readonly (readonly [label: string, value: string])[]
}

type Node = GenUICatalog.Surface["props"]["children"][number]

type MetricNode = typeof GenUICatalog.Metric.Type

type StatusNode = typeof GenUICatalog.Status.Type

/** A button's or row's action: text to reply with, or actions to run in place. */
type Behaviour = (typeof GenUICatalog.Button.Type)["props"]["action"]

type Tone = (typeof GenUICatalog.tones)[number]

type Value = string | boolean

const Surface = createContext<{
  readonly busy: () => boolean
  /** Replies with text (or `label` when there is none), or runs the actions against the surface's state. */
  readonly act: (behaviour: Behaviour, label: string, values?: GenUIReply["values"]) => void
  readonly open: (url: string) => void
}>()

const Form = createContext<{
  readonly value: (name: string) => Value | undefined
  readonly set: (name: string, value: Value) => void
  readonly values: () => GenUIReply["values"]
}>()

// The primary action is the contrast button, as in the app's own dialogs.
const buttonVariants = {
  primary: "contrast",
  secondary: "neutral",
  ghost: "ghost",
} as const satisfies Record<(typeof GenUICatalog.buttonVariants)[number], ButtonProps["variant"]>

const noticeIcons: Record<Tone, IconName> = {
  neutral: "info",
  info: "info",
  success: "circle-check",
  warning: "warning",
  danger: "circle-ban-sign",
}

/** The text a reply sends to the agent: the message, then the submitted values under `heading`. */
export function genuiReplyText(reply: GenUIReply, heading: string) {
  const values = reply.values ?? []

  return [
    reply.message,
    ...(values.length ? ["", heading, ...values.map(([label, value]) => `- ${label}: ${value}`)] : []),
  ].join("\n")
}

/**
 * Renders a GenUI program with OpenCode's own components. The program may still be streaming: each update parses
 * only the statements that changed and reconciles by statement, so blocks already on screen stay mounted while new
 * ones append below. Buttons can change the surface's state in place; only replies reach the agent.
 */
export function GenUISurface(props: {
  code: string
  /** The program is still being written. A block that does not render yet keeps showing its last version. */
  streaming?: boolean
  /** Turns off buttons, rows and form submission, e.g. while a reply is sending. */
  busy?: boolean
  onReply: (reply: GenUIReply) => void
  onOpen: (url: string) => void
  /** Shown when the program has no valid root yet. */
  fallback?: JSX.Element
}) {
  const parse = GenUILang.parser()
  const memory = new Map<string, unknown>()
  const program = createMemo(() => parse(GenUI.unfence(props.code), props.streaming === true))
  const start = createMemo(() => GenUILang.initial(program(), GenUICatalog.catalog).state)

  // Only the values the user changed; every other $name follows its declaration, including ones still streaming in.
  const [store, setStore] = createStore<{
    root?: GenUICatalog.Surface
    changes: { name: string; value: GenUILang.Data }[]
  }>({ changes: [] })

  const state = (): GenUILang.State =>
    new Map([...start(), ...store.changes.map((change) => [change.name, change.value] as const)])

  // Syncs the rendered tree into a store so unchanged nodes keep their identity across stream and state updates.
  createRenderEffect(() => {
    const rendered = GenUILang.render(program(), {
      catalog: GenUICatalog.catalog,
      root: GenUICatalog.Surface,
      state: state(),
      memory: props.streaming ? memory : undefined,
    })

    setStore("root", reconcile(rendered.root ?? undefined, { key: "statementId", merge: true }))
  })

  const apply = (outcome: GenUILang.Outcome | undefined, values: GenUIReply["values"]) => {
    if (outcome?.type === "set")
      setStore("changes", (changes) => [
        ...changes.filter((change) => change.name !== outcome.name),
        { name: outcome.name, value: outcome.value },
      ])

    if (outcome?.type === "reset")
      setStore("changes", (changes) => changes.filter((change) => !outcome.names.includes(change.name)))

    if (outcome?.type === "reply") props.onReply({ message: outcome.message, values })

    if (outcome?.type === "open") props.onOpen(outcome.url)
  }

  // Each action sees the state the previous one left.
  const run = (actions: readonly GenUILang.Action[], values: GenUIReply["values"]) =>
    actions.forEach((action) => apply(GenUILang.perform(action, program(), GenUICatalog.catalog, state()), values))

  const act = (behaviour: Behaviour, label: string, values?: GenUIReply["values"]) => {
    if (behaviour instanceof GenUILang.Action) return run([behaviour], values)

    if (isActionList(behaviour)) return run(behaviour, values)

    props.onReply({ message: behaviour ?? label, values })
  }

  return (
    <Surface.Provider value={{ busy: () => props.busy === true, act, open: props.onOpen }}>
      <Show when={store.root} fallback={props.fallback}>
        {(root) => (
          <div data-component="genui-surface">
            <Blocks items={root().props.children} />
          </div>
        )}
      </Show>
    </Surface.Provider>
  )
}

/** Renders blocks in order. A run of Status lines shares one card, like the rows of a settings list. */
function Blocks(props: { items: readonly Node[] }) {
  // Store nodes keep their identity, so `For` keeps every block mounted while the program grows.
  const visible = createMemo(() =>
    props.items.filter((item, index) => item.typeName !== "Status" || props.items[index - 1]?.typeName !== "Status"),
  )

  return (
    <For each={visible()}>
      {(node) => (isStatus(node) ? <StatusRun first={node} items={props.items} /> : <Block node={node} />)}
    </For>
  )
}

// `Array.isArray` cannot narrow a readonly array out of a union.
function isActionList(behaviour: Behaviour): behaviour is readonly GenUILang.Action[] {
  return Array.isArray(behaviour)
}

function isStatus(node: Node): node is StatusNode {
  return node.typeName === "Status"
}

function Block(props: { node: Node }): JSX.Element {
  const node = props.node

  switch (node.typeName) {
    case "Section":
      return (
        <section data-component="genui-section">
          <div data-slot="genui-section-heading">
            <h3 data-slot="genui-section-title">{node.props.title}</h3>
            <Show when={node.props.description}>
              {(description) => <p data-slot="genui-section-description">{description()}</p>}
            </Show>
          </div>
          <Blocks items={node.props.children} />
        </section>
      )
    case "Text":
      return (
        <p data-component="genui-text" data-muted={node.props.muted || undefined}>
          {node.props.text}
        </p>
      )
    case "Markdown":
      return <Markdown text={node.props.text} class="text-14-regular" />
    case "Code":
      return <Markdown text={fence(node.props.code, node.props.language ?? "")} />
    case "Divider":
      return <Divider />
    case "Notice":
      return (
        <div data-component="genui-notice" data-tone={node.props.tone ?? "neutral"}>
          <span data-slot="genui-notice-icon">
            <Icon name={noticeIcons[node.props.tone ?? "neutral"]} />
          </span>
          <div data-slot="genui-notice-body">
            <div data-slot="genui-label">{node.props.title}</div>
            <Show when={node.props.description}>
              {(description) => <p data-slot="genui-section-description">{description()}</p>}
            </Show>
          </div>
        </div>
      )
    case "Status":
      return <StatusRun first={node} items={[node]} />
    case "Metrics":
      return (
        <div data-component="genui-card">
          <div data-slot="genui-metrics">
            <For each={node.props.items}>
              {(metric) => (
                <div data-slot="genui-metric">
                  <span data-slot="genui-metric-label">{metric.props.label}</span>
                  <span data-slot="genui-metric-headline">
                    <span data-slot="genui-metric-value">{String(metric.props.value)}</span>
                    <Show when={metric.props.trend}>
                      {(trend) => (
                        <Sparkline values={trend()} tone={deltaTone(metric.props.delta, metric.props.inverse)} />
                      )}
                    </Show>
                  </span>
                  <Show when={(metric.props.delta !== undefined && metric.props.delta !== null) || metric.props.detail}>
                    <span data-slot="genui-metric-foot">
                      <Show when={metric.props.delta ?? undefined}>
                        {(delta) => <Delta value={delta()} inverse={metric.props.inverse} />}
                      </Show>
                      <Show when={metric.props.detail}>
                        {(detail) => <span data-slot="genui-metric-detail">{detail()}</span>}
                      </Show>
                    </span>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </div>
      )
    case "Progress": {
      const value = Math.min(100, Math.max(0, node.props.value))

      return (
        <div data-component="genui-progress">
          <div data-slot="genui-progress-heading">
            <span data-slot="genui-row-label">{node.props.label}</span>
            <span data-slot="genui-row-value">{node.props.detail ?? `${Math.round(value)}%`}</span>
          </div>
          <div
            data-slot="genui-progress-track"
            role="progressbar"
            aria-label={node.props.label}
            aria-valuenow={value}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <div data-slot="genui-progress-fill" style={{ width: `${value}%` }} />
          </div>
        </div>
      )
    }

    case "BarList": {
      const max = Math.max(0, ...node.props.items.map((item) => item.value))

      return (
        <div data-component="genui-card">
          <For each={node.props.items}>
            {(item) => (
              <div data-slot="genui-row">
                <div
                  data-slot="genui-bar"
                  style={{ width: `${max > 0 ? (Math.max(0, item.value) / max) * 100 : 0}%` }}
                />
                <span data-slot="genui-row-label">{item.label}</span>
                <span data-slot="genui-row-value">{item.display ?? String(item.value)}</span>
              </div>
            )}
          </For>
        </div>
      )
    }

    case "Table":
      return (
        <div data-component="genui-table">
          <table>
            <thead>
              <tr>
                <For each={node.props.columns}>{(column) => <th>{column}</th>}</For>
              </tr>
            </thead>
            <tbody>
              <For each={node.props.rows}>
                {(row) => (
                  <tr>
                    <For each={row}>
                      {(cell) => <td data-numeric={Number.isFinite(cell) || undefined}>{String(cell)}</td>}
                    </For>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </div>
      )
    case "Steps":
      return (
        <div data-component="genui-card">
          <For each={node.props.items}>
            {(item) => (
              <div data-slot="genui-row" data-state={item.state ?? "pending"}>
                <Show
                  when={item.state === "done"}
                  fallback={
                    <span
                      data-slot="genui-dot"
                      data-tone={item.state === "failed" ? "danger" : (item.state ?? "pending")}
                    />
                  }
                >
                  <span data-slot="genui-row-icon">
                    <Icon name="check-small" />
                  </span>
                </Show>
                <span data-slot="genui-row-label">{item.title}</span>
                <Show when={item.detail}>{(detail) => <span data-slot="genui-row-value">{detail()}</span>}</Show>
              </div>
            )}
          </For>
        </div>
      )
    case "Group":
      return (
        <div data-component="genui-card">
          <For each={node.props.rows}>{(row) => <GroupRow row={row} />}</For>
        </div>
      )
    case "BarChart":
      return (
        <BarChart
          labels={node.props.labels}
          series={seriesOf(node.props.series)}
          stacked={node.props.stacked}
          format={node.props.format}
        />
      )
    case "LineChart":
      return (
        <LineChart
          labels={node.props.labels}
          series={seriesOf(node.props.series)}
          format={node.props.format}
          area={node.props.area}
        />
      )
    case "AreaChart":
      return (
        <LineChart
          labels={node.props.labels}
          series={seriesOf(node.props.series)}
          format={node.props.format}
          area
          stacked={node.props.stacked}
        />
      )
    case "ComboChart":
      return (
        <ComboChart
          labels={node.props.labels}
          bars={node.props.bars.props}
          line={node.props.line.props}
          barFormat={node.props.barFormat}
          lineFormat={node.props.lineFormat}
        />
      )
    case "ProjectionChart":
      return (
        <ProjectionChart
          labels={node.props.labels}
          actual={node.props.actual}
          projected={node.props.projected}
          target={node.props.target}
          format={node.props.format}
          targetLabel={node.props.targetLabel}
        />
      )
    case "DonutChart":
      return <DonutChart items={node.props.items} center={node.props.center} format={node.props.format} />
    case "ShareBar":
      return <ShareBar items={node.props.items} format={node.props.format} />
    case "Meter":
      return (
        <Meter label={node.props.label} value={node.props.value} detail={node.props.detail} tone={node.props.tone} />
      )
    case "Gauge":
      return <Gauge label={node.props.label} value={node.props.value} detail={node.props.detail} />
    case "Pips":
      return (
        <Pips label={node.props.label} value={node.props.value} detail={node.props.detail} tone={node.props.tone} />
      )
    case "StatusStrip":
      return <StatusStrip items={node.props.items} start={node.props.start} end={node.props.end} />
    case "Heatmap":
      return (
        <Heatmap
          rows={node.props.rows}
          columns={node.props.columns}
          values={node.props.values}
          format={node.props.format}
        />
      )
    case "RadarChart":
      return <RadarChart axes={node.props.axes} series={seriesOf(node.props.series)} />
    case "ScatterChart":
      return (
        <ScatterChart
          points={node.props.points}
          xLabel={node.props.xLabel}
          yLabel={node.props.yLabel}
          xFormat={node.props.xFormat}
          yFormat={node.props.yFormat}
        />
      )
    case "Comparison":
      return <Comparison columns={node.props.columns} rows={node.props.rows.map((row) => row.props)} />
    case "Columns":
      return (
        <div data-component="genui-columns">
          <Blocks items={node.props.children} />
        </div>
      )
    case "Actions":
      return <Actions node={node} />
    case "Form":
      return <FormBlock node={node} />
  }
}

/** One card for a Status and the Status lines right after it, which `Blocks` skips. */
function StatusRun(props: { first: StatusNode; items: readonly Node[] }) {
  const run = createMemo(() => {
    const start = props.items.indexOf(props.first)
    const end = props.items.findIndex((next, at) => at > start && next.typeName !== "Status")

    return props.items.slice(start, end === -1 ? undefined : end).filter(isStatus)
  })

  return (
    <div data-component="genui-card">
      <For each={run()}>
        {(status) => (
          <div data-slot="genui-row">
            <span data-slot="genui-dot" data-tone={status.props.tone} />
            <span data-slot="genui-row-label">{status.props.label}</span>
            <Show when={status.props.detail}>{(detail) => <span data-slot="genui-row-value">{detail()}</span>}</Show>
          </div>
        )}
      </For>
    </div>
  )
}

function GroupRow(props: { row: typeof GenUICatalog.Row.Type }) {
  const surface = useContext(Surface)

  const content = () => (
    <>
      <span data-slot="genui-row-label">{props.row.props.label}</span>
      <Show when={props.row.props.value}>{(value) => <span data-slot="genui-row-value">{value()}</span>}</Show>
    </>
  )

  return (
    <Show when={props.row.props.action} fallback={<div data-slot="genui-row">{content()}</div>}>
      {(action) => (
        <button
          type="button"
          data-slot="genui-row"
          disabled={surface?.busy()}
          onClick={() => surface?.act(action(), props.row.props.label)}
        >
          {content()}
          <span data-slot="genui-row-icon">
            <Icon name="chevron-right" size="small" />
          </span>
        </button>
      )}
    </Show>
  )
}

function Actions(props: { node: typeof GenUICatalog.Actions.Type }) {
  const surface = useContext(Surface)
  const form = useContext(Form)

  return (
    <div data-component="genui-actions">
      <For each={props.node.props.items}>
        {(item) => (
          <Show
            when={item.typeName === "Button" ? item.props : undefined}
            fallback={
              <Show when={item.typeName === "Link" ? item.props : undefined}>
                {(link) => (
                  <Button
                    size="normal"
                    variant="ghost"
                    icon="outline-arrow-up-right"
                    onClick={() => surface?.open(link().url)}
                  >
                    {link().label}
                  </Button>
                )}
              </Show>
            }
          >
            {(button) => (
              <Button
                size="normal"
                variant={buttonVariants[button().variant ?? "secondary"]}
                disabled={surface?.busy()}
                onClick={() => surface?.act(button().action, button().label, form?.values())}
              >
                {button().label}
              </Button>
            )}
          </Show>
        )}
      </For>
    </div>
  )
}

function FormBlock(props: { node: typeof GenUICatalog.Form.Type }) {
  const fields = () => props.node.props.fields

  // Only what the user changed; a field's default comes from its current node, so fields that stream in later
  // still start from theirs.
  const [state, setState] = createStore<{ values: { name: string; value: Value }[] }>({ values: [] })

  const value = (name: string) =>
    state.values.find((entry) => entry.name === name)?.value ??
    initial(fields().find((field) => field.props.name === name))

  const set = (name: string, next: Value) =>
    setState("values", (values) => [...values.filter((entry) => entry.name !== name), { name, value: next }])

  return (
    <Form.Provider
      value={{
        value,
        set,
        values: () =>
          fields().flatMap((field) => {
            const current = value(field.props.name)

            return current === undefined || current === "" ? [] : [[field.props.label, String(current)] as const]
          }),
      }}
    >
      <form data-component="genui-form" onSubmit={(event) => event.preventDefault()}>
        <For each={fields()}>{(field) => <Field field={field} />}</For>
        <Actions node={props.node.props.actions} />
      </form>
    </Form.Provider>
  )
}

function initial(field: GenUICatalog.Field | undefined): Value | undefined {
  if (!field) return undefined

  if (field.typeName === "Toggle") return field.props.value ?? false

  return field.props.value ?? undefined
}

function Field(props: { field: GenUICatalog.Field }): JSX.Element {
  const form = useContext(Form)
  const field = props.field

  const text = () => {
    const current = form?.value(field.props.name)

    return current === undefined || current === true || current === false ? "" : current
  }

  const hint = (value: string | null | undefined) => (
    <Show when={value}>{(content) => <span data-slot="genui-hint">{content()}</span>}</Show>
  )

  switch (field.typeName) {
    case "Input":
      return (
        <label data-slot="genui-field">
          <span data-slot="genui-label">{field.props.label}</span>
          <TextInput
            class="!w-full"
            placeholder={field.props.placeholder ?? undefined}
            value={text()}
            onInput={(event) => form?.set(field.props.name, event.currentTarget.value)}
          />
          {hint(field.props.hint)}
        </label>
      )
    case "TextArea":
      return (
        <label data-slot="genui-field">
          <span data-slot="genui-label">{field.props.label}</span>
          <Textarea
            class="!w-full"
            placeholder={field.props.placeholder ?? undefined}
            value={text()}
            onInput={(event) => form?.set(field.props.name, event.currentTarget.value)}
          />
          {hint(field.props.hint)}
        </label>
      )
    case "Select":
      return (
        <div data-slot="genui-field">
          <span data-slot="genui-label">{field.props.label}</span>
          <Select
            class="!w-full"
            options={[...field.props.options]}
            current={text() || undefined}
            onSelect={(option) => form?.set(field.props.name, option ?? "")}
          />
          {hint(field.props.hint)}
        </div>
      )
    case "Choice":
      return (
        // The group's own caption label is smaller than every other field's; show the shared field label instead.
        <div data-slot="genui-field">
          <span data-slot="genui-label">{field.props.label}</span>
          <RadioGroup
            label={field.props.label}
            hideLabel
            value={text()}
            onChange={(option) => form?.set(field.props.name, option)}
          >
            <For each={field.props.options}>{(option) => <RadioItem value={option} label={option} />}</For>
          </RadioGroup>
          {hint(field.props.hint)}
        </div>
      )
    case "Segmented":
      return (
        <div data-slot="genui-field">
          <span data-slot="genui-label">{field.props.label}</span>
          <SegmentedControl
            class="segmented-control-v2--full-width"
            value={text() || null}
            onChange={(option) => form?.set(field.props.name, option ?? "")}
          >
            <For each={field.props.options}>
              {(option) => <SegmentedControlItem value={option}>{option}</SegmentedControlItem>}
            </For>
          </SegmentedControl>
        </div>
      )
    case "Toggle":
      return (
        <Switch
          checked={form?.value(field.props.name) === true}
          description={field.props.hint ?? undefined}
          onChange={(checked) => form?.set(field.props.name, checked)}
        >
          {field.props.label}
        </Switch>
      )
  }
}

/** Fences code with one more backtick than its longest run, so a code sample cannot close its own block. */
function fence(code: string, language: string) {
  const ticks = "`".repeat(Math.max(3, ...[...code.matchAll(/`+/gu)].map((match) => match[0].length + 1)))

  return `${ticks}${language}\n${code}\n${ticks}`
}

function deltaTone(delta: MetricNode["props"]["delta"], inverse: MetricNode["props"]["inverse"]) {
  if (delta === undefined || delta === null || delta === 0) return undefined

  return delta > 0 !== (inverse === true) ? ("success" as const) : ("danger" as const)
}

function seriesOf(series: readonly (typeof GenUICatalog.Series.Type)[]) {
  return series.map((item) => item.props)
}
