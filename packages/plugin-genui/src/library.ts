export * as GenUILibrary from "./library.js"

import { createLibrary, createParser, defineComponent } from "@openuidev/lang-core"
import { Option, Schema, SchemaTransformation } from "effect"
import { z } from "zod"

// Schemas only: the server builds the prompt and validates from them, and the app maps each name to its own
// renderer. Positional argument order is the property order below, so append new props at the end.
const define = <T extends z.ZodObject>(name: string, description: string, props: T) =>
  defineComponent({ name, description, props, component: null })

export const tones = ["neutral", "success", "warning", "danger", "info"] as const
export const stepStates = ["done", "current", "pending", "failed"] as const
export const buttonVariants = ["primary", "secondary", "ghost"] as const
const tone = z.enum(tones)

export const Text = define(
  "Text",
  "Plain paragraph. Use Markdown instead for lists, links, emphasis or inline code.",
  z.object({ text: z.string(), muted: z.boolean().optional() }),
)
export const Markdown = define(
  "Markdown",
  "GitHub-flavored Markdown block for prose with lists, links, emphasis and inline code.",
  z.object({ text: z.string() }),
)
export const Code = define(
  "Code",
  "Syntax-highlighted code block.",
  z.object({ code: z.string(), language: z.string().optional() }),
)
export const Divider = define("Divider", "Thin horizontal rule between unrelated blocks.", z.object({}))
export const Notice = define(
  "Notice",
  "Callout for one important fact: a warning, a failure, or a success the user must not miss. At most one per surface.",
  z.object({ title: z.string(), description: z.string().optional(), tone: tone.optional() }),
)
export const Status = define(
  "Status",
  "One line with a colored dot: a check, service or job state. detail is right-aligned muted text.",
  z.object({ label: z.string(), tone, detail: z.string().optional() }),
)
export const Metric = define(
  "Metric",
  "One headline number inside Metrics. value is preformatted text; detail is a short muted note. delta is the percent change, colored green when up (red when inverse is true, for costs, latency or errors). trend is a short series drawn as a sparkline.",
  z.object({
    label: z.string(),
    value: z.union([z.string(), z.number()]),
    detail: z.string().optional(),
    delta: z.number().optional(),
    trend: z.array(z.number()).optional(),
    inverse: z.boolean().optional(),
  }),
)
export const Metrics = define(
  "Metrics",
  "Grid of 2 to 4 Metric cells for headline numbers.",
  z.object({ items: z.array(Metric.ref) }),
)
export const Progress = define(
  "Progress",
  "Labeled progress bar. value is a percentage from 0 to 100; detail replaces the percentage text.",
  z.object({ label: z.string(), value: z.number(), detail: z.string().optional() }),
)
export const BarList = define(
  "BarList",
  "Ranked horizontal bars for comparing magnitudes, largest first. display is the formatted value text.",
  z.object({
    items: z.array(z.object({ label: z.string(), value: z.number(), display: z.string().optional() })),
  }),
)
export const Table = define(
  "Table",
  "Read-only table. rows is an array of rows; each row has one plain string or number per column.",
  z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.union([z.string(), z.number()]))) }),
)
// Charts. Values are raw numbers; `format` decides how axes, tooltips and labels print them.
export const formats = ["compact", "number", "currency", "percent", "duration", "bytes"] as const
const format = z.enum(formats)
const value = z.number().nullable()
const item = z.object({ label: z.string(), value: z.number() })

export const Series = define(
  "Series",
  "One named data series for a chart, one value per label. null leaves a gap.",
  z.object({ name: z.string(), values: z.array(value) }),
)
export const BarChart = define(
  "BarChart",
  "Vertical bars over categories or time, e.g. daily cost or requests per day. One Series draws monochrome bars; several draw grouped bars, or stacked when stacked is true.",
  z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    stacked: z.boolean().optional(),
    format: format.optional(),
  }),
)
export const LineChart = define(
  "LineChart",
  "Smooth trend lines over time. area shades under a single line.",
  z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    format: format.optional(),
    area: z.boolean().optional(),
  }),
)
export const AreaChart = define(
  "AreaChart",
  "Filled trend areas over time; stacked shows how parts add up to a total.",
  z.object({
    labels: z.array(z.string()),
    series: z.array(Series.ref),
    format: format.optional(),
    stacked: z.boolean().optional(),
  }),
)
export const ComboChart = define(
  "ComboChart",
  "Bars and a line on two scales over the same labels, e.g. tokens as bars and users as a line.",
  z.object({
    labels: z.array(z.string()),
    bars: Series.ref,
    line: Series.ref,
    barFormat: format.optional(),
    lineFormat: format.optional(),
  }),
)
export const ProjectionChart = define(
  "ProjectionChart",
  "Actual values so far plus a projection to the end of the range, with an optional target or limit line. actual has null after the last known point; projected has null before it.",
  z.object({
    labels: z.array(z.string()),
    actual: z.array(value),
    projected: z.array(value),
    target: z.number().optional(),
    format: format.optional(),
    targetLabel: z.string().optional(),
  }),
)
export const DonutChart = define(
  "DonutChart",
  "Parts of a whole, 2 to 8 items, with a legend. center is the headline figure shown above the ring, e.g. the formatted total.",
  z.object({ items: z.array(item), center: z.string().optional(), format: format.optional() }),
)
export const ShareBar = define(
  "ShareBar",
  "One horizontal bar split into parts of a whole, with a legend. Compact alternative to DonutChart.",
  z.object({ items: z.array(item), format: format.optional() }),
)
export const Meter = define(
  "Meter",
  "Capacity or quota used, value 0 to 100. tone auto turns warning at 70 and danger above 95.",
  z.object({
    label: z.string(),
    value: z.number(),
    detail: z.string().optional(),
    tone: z.enum([...tones, "auto"]).optional(),
  }),
)
export const Gauge = define(
  "Gauge",
  "Where one value sits on a 0 to 100 scale, e.g. a ratio, score or percentile.",
  z.object({ label: z.string(), value: z.number(), detail: z.string().optional() }),
)
export const Pips = define(
  "Pips",
  "Twenty-step rating meter for a score from 0 to 100, compact enough for lists.",
  z.object({ label: z.string(), value: z.number(), detail: z.string().optional(), tone: tone.optional() }),
)
export const StatusStrip = define(
  "StatusStrip",
  "Timeline of discrete states, oldest first, e.g. CI runs, uptime checks or deploys. Each item has a label for its tooltip and a tone.",
  z.object({
    items: z.array(z.object({ label: z.string(), tone })),
    start: z.string().optional(),
    end: z.string().optional(),
  }),
)
export const Heatmap = define(
  "Heatmap",
  "Intensity grid, e.g. activity by weekday and hour or errors by service and day. values has one row per row label and one value per column.",
  z.object({
    rows: z.array(z.string()),
    columns: z.array(z.string()),
    values: z.array(z.array(value)),
    format: format.optional(),
  }),
)
export const RadarChart = define(
  "RadarChart",
  "Compare up to 4 series across 3 to 8 axes, each scored 0 to 100.",
  z.object({ axes: z.array(z.string()), series: z.array(Series.ref) }),
)
export const ScatterChart = define(
  "ScatterChart",
  "Points on two numeric axes to show correlation or trade-offs, e.g. cost against quality.",
  z.object({
    points: z.array(z.object({ label: z.string(), x: z.number(), y: z.number() })),
    xLabel: z.string(),
    yLabel: z.string(),
    xFormat: format.optional(),
    yFormat: format.optional(),
  }),
)
export const ComparisonRow = define(
  "ComparisonRow",
  "One row of a Comparison. best marks the winning cell: higher or lower numbers are better.",
  z.object({
    label: z.string(),
    values: z.array(z.union([z.string(), z.number()])),
    best: z.enum(["higher", "lower"]).optional(),
  }),
)
export const Comparison = define(
  "Comparison",
  "Side-by-side comparison of options, one column per option, with the best cell in each row highlighted.",
  z.object({ columns: z.array(z.string()), rows: z.array(ComparisonRow.ref) }),
)

export const Steps = define(
  "Steps",
  "Ordered checklist for a plan or pipeline.",
  z.object({
    items: z.array(
      z.object({ title: z.string(), detail: z.string().optional(), state: z.enum(stepStates).optional() }),
    ),
  }),
)
export const Row = define(
  "Row",
  "One row of a Group: a label with an optional right-aligned value. A row with message is clickable and sends that message to you.",
  z.object({ label: z.string(), value: z.string().optional(), message: z.string().optional() }),
)
export const Group = define(
  "Group",
  "Card of Rows for key-value facts or a list of choices.",
  z.object({ rows: z.array(Row.ref) }),
)
export const Button = define(
  "Button",
  "Clicking sends message (default: label) to you as the user's reply. Inside a Form it submits the form values with it. Use primary for the single main action.",
  z.object({ label: z.string(), message: z.string().optional(), variant: z.enum(buttonVariants).optional() }),
)
export const Link = define(
  "Link",
  "Button that opens an http(s) URL from the conversation or a tool result. Never invent URLs.",
  z.object({ label: z.string(), url: z.string() }),
)
export const Actions = define(
  "Actions",
  "Row of buttons.",
  z.object({ items: z.array(z.union([Button.ref, Link.ref])) }),
)

const field = { name: z.string(), label: z.string() }
export const Input = define(
  "Input",
  "Single-line text field. name is the key in the submitted values.",
  z.object({ ...field, placeholder: z.string().optional(), value: z.string().optional(), hint: z.string().optional() }),
)
export const TextArea = define(
  "TextArea",
  "Multi-line text field.",
  z.object({ ...field, placeholder: z.string().optional(), value: z.string().optional(), hint: z.string().optional() }),
)
export const Select = define(
  "Select",
  "Dropdown for one of many options (more than 4).",
  z.object({ ...field, options: z.array(z.string()), value: z.string().optional(), hint: z.string().optional() }),
)
export const Choice = define(
  "Choice",
  "Radio list for one of 2 to 4 options that need to be read side by side.",
  z.object({ ...field, options: z.array(z.string()), value: z.string().optional(), hint: z.string().optional() }),
)
export const Segmented = define(
  "Segmented",
  "Segmented control for one of 2 or 3 short options.",
  z.object({ ...field, options: z.array(z.string()), value: z.string().optional() }),
)
export const Toggle = define(
  "Toggle",
  "On/off switch.",
  z.object({ ...field, value: z.boolean().optional(), hint: z.string().optional() }),
)
export const Form = define(
  "Form",
  "Fields with their submit actions. Exactly one primary Button submits; every field name is unique.",
  z.object({
    fields: z.array(z.union([Input.ref, TextArea.ref, Select.ref, Choice.ref, Segmented.ref, Toggle.ref])),
    actions: Actions.ref,
  }),
)

const blocks = [
  Text.ref,
  Markdown.ref,
  Code.ref,
  Divider.ref,
  Notice.ref,
  Status.ref,
  Metrics.ref,
  Progress.ref,
  BarList.ref,
  Table.ref,
  Steps.ref,
  Group.ref,
  Actions.ref,
  Form.ref,
  BarChart.ref,
  LineChart.ref,
  AreaChart.ref,
  ComboChart.ref,
  ProjectionChart.ref,
  DonutChart.ref,
  ShareBar.ref,
  Meter.ref,
  Gauge.ref,
  Pips.ref,
  StatusStrip.ref,
  Heatmap.ref,
  RadarChart.ref,
  ScatterChart.ref,
  Comparison.ref,
] as const
export const Columns = define(
  "Columns",
  "Two or three blocks side by side, e.g. a DonutChart next to Metrics. Stacks when the panel is narrow.",
  z.object({ children: z.array(z.union(blocks)) }),
)
export const Section = define(
  "Section",
  "Titled group of blocks. Sections do not nest.",
  z.object({
    title: z.string(),
    children: z.array(z.union([...blocks, Columns.ref])),
    description: z.string().optional(),
  }),
)
export const Surface = define(
  "Surface",
  "The root. Blocks and Sections stack vertically.",
  z.object({ children: z.array(z.union([...blocks, Columns.ref, Section.ref])) }),
)

export const library = createLibrary({
  root: "Surface",
  components: [
    Surface,
    Section,
    Columns,
    Text,
    Markdown,
    Code,
    Divider,
    Notice,
    Status,
    Metrics,
    Metric,
    Progress,
    BarList,
    Table,
    Steps,
    Group,
    Row,
    Actions,
    Button,
    Link,
    Form,
    Input,
    TextArea,
    Select,
    Choice,
    Segmented,
    Toggle,
    Series,
    BarChart,
    LineChart,
    AreaChart,
    ComboChart,
    ProjectionChart,
    DonutChart,
    ShareBar,
    Meter,
    Gauge,
    Pips,
    StatusStrip,
    Heatmap,
    RadarChart,
    ScatterChart,
    Comparison,
    ComparisonRow,
  ],
  componentGroups: [
    { name: "Layout", components: ["Surface", "Section", "Columns"] },
    { name: "Content", components: ["Text", "Markdown", "Code", "Divider", "Notice", "Status"] },
    { name: "Data", components: ["Metrics", "Metric", "Progress", "BarList", "Table", "Steps", "Group", "Row"] },
    {
      name: "Charts",
      components: [
        "Series",
        "BarChart",
        "LineChart",
        "AreaChart",
        "ComboChart",
        "ProjectionChart",
        "DonutChart",
        "ShareBar",
        "RadarChart",
        "ScatterChart",
        "Heatmap",
      ],
      notes: [
        "Prefer a chart over a table whenever numbers form a trend, a ranking, a share or a distribution.",
        "Pass raw numbers and pick a format: compact (1.2k, 3.4M), number, currency (USD), percent (values already 0-100), duration (milliseconds) or bytes.",
        "Keep labels short (e.g. Mon, 3/14, 14:00); about 7 to 31 labels read best.",
      ],
    },
    {
      name: "Meters",
      components: ["Meter", "Gauge", "Pips", "StatusStrip", "Comparison", "ComparisonRow"],
    },
    { name: "Actions", components: ["Actions", "Button", "Link"] },
    {
      name: "Forms",
      components: ["Form", "Input", "TextArea", "Select", "Choice", "Segmented", "Toggle"],
      notes: ["Field values reach you only when the user presses a Button inside the Form."],
    },
  ],
})

const parser = createParser(library.toJSONSchema(), "Surface")

/**
 * Parses an OpenUI Lang program against this library. Invalid nodes become null and are listed in `meta`. A program
 * cut off mid-stream parses too: its last statement is closed and nodes still missing required props are dropped.
 */
export const parse = (code: string) => parser.parse(code)

/** A render call's arguments as clients see them: any field may still be missing or cut off while it streams. */
export const RenderInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  surfaceID: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
})
export type RenderInput = typeof RenderInput.Type

/** Strips the Markdown fence models sometimes wrap a program in, including one that is still open. */
export const unfence = (code: string) =>
  code
    .trim()
    .replace(/^```[\w-]*\n?/u, "")
    .replace(/\n?```$/u, "")

// The parser's element tree as typed values for renderers. The parser has already checked props against the JSON
// schema above and replaced invalid nodes with null, so these mirror the zod props one to one; `library.test.ts`
// keeps the two in step.
// `statementId` names the statement a node came from; renderers key by it so a re-parse while the program streams
// keeps the nodes it already showed.
const element = <const Name extends string, const Fields extends Schema.Struct.Fields>(
  typeName: Name,
  fields: Fields,
) =>
  Schema.Struct({
    typeName: Schema.Literal(typeName),
    props: Schema.Struct(fields),
    statementId: Schema.optional(Schema.String),
  })
const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))
// A child the parser accepted but that does not belong in this slot (models misplace blocks) becomes null, so its
// siblings still render instead of the whole surface failing.
const children = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownOption(schema)

  return Schema.Array(Schema.Unknown).pipe(
    Schema.decodeTo(
      Schema.Array(Schema.NullOr(Schema.toType(schema))),
      SchemaTransformation.transform({
        decode: (items: ReadonlyArray<unknown>): ReadonlyArray<S["Type"] | null> =>
          items.map((item) => Option.getOrNull(decode(item))),
        encode: (items: ReadonlyArray<S["Type"] | null>): ReadonlyArray<unknown> => items,
      }),
    ),
  )
}
const label = Schema.String
const scalar = Schema.Union([Schema.String, Schema.Number])

export const TextElement = element("Text", { text: Schema.String, muted: maybe(Schema.Boolean) })
export const MarkdownElement = element("Markdown", { text: Schema.String })
export const CodeElement = element("Code", { code: Schema.String, language: maybe(Schema.String) })
export const DividerElement = element("Divider", {})
export const NoticeElement = element("Notice", {
  title: label,
  description: maybe(Schema.String),
  tone: maybe(Schema.Literals(tones)),
})
export const StatusElement = element("Status", {
  label,
  tone: Schema.Literals(tones),
  detail: maybe(Schema.String),
})
export const MetricElement = element("Metric", {
  label,
  value: scalar,
  detail: maybe(Schema.String),
  delta: maybe(Schema.Number),
  trend: maybe(Schema.Array(Schema.Number)),
  inverse: maybe(Schema.Boolean),
})
export const MetricsElement = element("Metrics", { items: children(MetricElement) })
export const ProgressElement = element("Progress", { label, value: Schema.Number, detail: maybe(Schema.String) })
export const BarListElement = element("BarList", {
  items: Schema.Array(Schema.Struct({ label, value: Schema.Number, display: maybe(Schema.String) })),
})
export const TableElement = element("Table", {
  columns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Array(scalar)),
})
export const StepsElement = element("Steps", {
  items: Schema.Array(
    Schema.Struct({ title: Schema.String, detail: maybe(Schema.String), state: maybe(Schema.Literals(stepStates)) }),
  ),
})
export const RowElement = element("Row", { label, value: maybe(Schema.String), message: maybe(Schema.String) })
export const GroupElement = element("Group", { rows: children(RowElement) })
export const ButtonElement = element("Button", {
  label,
  message: maybe(Schema.String),
  variant: maybe(Schema.Literals(buttonVariants)),
})
export const LinkElement = element("Link", { label, url: Schema.String })
export const ActionsElement = element("Actions", { items: children(Schema.Union([ButtonElement, LinkElement])) })

const fieldElement = { name: Schema.String, label }
export const InputElement = element("Input", {
  ...fieldElement,
  placeholder: maybe(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const TextAreaElement = element("TextArea", {
  ...fieldElement,
  placeholder: maybe(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const SelectElement = element("Select", {
  ...fieldElement,
  options: Schema.Array(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const ChoiceElement = element("Choice", {
  ...fieldElement,
  options: Schema.Array(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const SegmentedElement = element("Segmented", {
  ...fieldElement,
  options: Schema.Array(Schema.String),
  value: maybe(Schema.String),
})
export const ToggleElement = element("Toggle", {
  ...fieldElement,
  value: maybe(Schema.Boolean),
  hint: maybe(Schema.String),
})
export const FieldElement = Schema.Union([
  InputElement,
  TextAreaElement,
  SelectElement,
  ChoiceElement,
  SegmentedElement,
  ToggleElement,
])
export type FieldElement = typeof FieldElement.Type
export const FormElement = element("Form", { fields: children(FieldElement), actions: Schema.NullOr(ActionsElement) })

const formatElement = maybe(Schema.Literals(formats))
const numbers = Schema.Array(Schema.NullOr(Schema.Number))
const items = Schema.Array(Schema.Struct({ label, value: Schema.Number }))
export const SeriesElement = element("Series", { name: label, values: numbers })
export type SeriesElement = typeof SeriesElement.Type
const series = children(SeriesElement)
export const BarChartElement = element("BarChart", {
  labels: Schema.Array(Schema.String),
  series,
  stacked: maybe(Schema.Boolean),
  format: formatElement,
})
export const LineChartElement = element("LineChart", {
  labels: Schema.Array(Schema.String),
  series,
  format: formatElement,
  area: maybe(Schema.Boolean),
})
export const AreaChartElement = element("AreaChart", {
  labels: Schema.Array(Schema.String),
  series,
  format: formatElement,
  stacked: maybe(Schema.Boolean),
})
export const ComboChartElement = element("ComboChart", {
  labels: Schema.Array(Schema.String),
  bars: Schema.NullOr(SeriesElement),
  line: Schema.NullOr(SeriesElement),
  barFormat: formatElement,
  lineFormat: formatElement,
})
export const ProjectionChartElement = element("ProjectionChart", {
  labels: Schema.Array(Schema.String),
  actual: numbers,
  projected: numbers,
  target: maybe(Schema.Number),
  format: formatElement,
  targetLabel: maybe(Schema.String),
})
export const DonutChartElement = element("DonutChart", { items, center: maybe(Schema.String), format: formatElement })
export const ShareBarElement = element("ShareBar", { items, format: formatElement })
export const MeterElement = element("Meter", {
  label,
  value: Schema.Number,
  detail: maybe(Schema.String),
  tone: maybe(Schema.Literals([...tones, "auto"])),
})
export const GaugeElement = element("Gauge", { label, value: Schema.Number, detail: maybe(Schema.String) })
export const PipsElement = element("Pips", {
  label,
  value: Schema.Number,
  detail: maybe(Schema.String),
  tone: maybe(Schema.Literals(tones)),
})
export const StatusStripElement = element("StatusStrip", {
  items: Schema.Array(Schema.Struct({ label, tone: Schema.Literals(tones) })),
  start: maybe(Schema.String),
  end: maybe(Schema.String),
})
export const HeatmapElement = element("Heatmap", {
  rows: Schema.Array(Schema.String),
  columns: Schema.Array(Schema.String),
  values: Schema.Array(numbers),
  format: formatElement,
})
export const RadarChartElement = element("RadarChart", { axes: Schema.Array(Schema.String), series })
export const ScatterChartElement = element("ScatterChart", {
  points: Schema.Array(Schema.Struct({ label, x: Schema.Number, y: Schema.Number })),
  xLabel: label,
  yLabel: label,
  xFormat: formatElement,
  yFormat: formatElement,
})
export const ComparisonRowElement = element("ComparisonRow", {
  label,
  values: Schema.Array(scalar),
  best: maybe(Schema.Literals(["higher", "lower"])),
})
export const ComparisonElement = element("Comparison", {
  columns: Schema.Array(Schema.String),
  rows: children(ComparisonRowElement),
})

export const BlockElement = Schema.Union([
  TextElement,
  MarkdownElement,
  CodeElement,
  DividerElement,
  NoticeElement,
  StatusElement,
  MetricsElement,
  ProgressElement,
  BarListElement,
  TableElement,
  StepsElement,
  GroupElement,
  ActionsElement,
  FormElement,
  BarChartElement,
  LineChartElement,
  AreaChartElement,
  ComboChartElement,
  ProjectionChartElement,
  DonutChartElement,
  ShareBarElement,
  MeterElement,
  GaugeElement,
  PipsElement,
  StatusStripElement,
  HeatmapElement,
  RadarChartElement,
  ScatterChartElement,
  ComparisonElement,
])
export type BlockElement = typeof BlockElement.Type
export const ColumnsElement = element("Columns", { children: children(BlockElement) })
export const SectionElement = element("Section", {
  title: label,
  children: children(Schema.Union([BlockElement, ColumnsElement])),
  description: maybe(Schema.String),
})
export const SurfaceElement = element("Surface", {
  children: children(Schema.Union([BlockElement, ColumnsElement, SectionElement])),
})
export type SurfaceElement = typeof SurfaceElement.Type

/** Programs the guide shows the model. Each parses cleanly and decodes as a SurfaceElement. */
export const examples = [
  {
    title: "Test run summary",
    code: `root = Surface([summary, checks, coverage, next])
summary = Metrics([tests, duration, cov])
tests = Metric("Tests", "412", "3 failed")
duration = Metric("Duration", "48s", "6s faster than main")
cov = Metric("Coverage", "81.4%", "+0.6%")
checks = Section("Checks", [typecheck, unit, lint])
typecheck = Status("Typecheck", "success", "12s")
unit = Status("Unit tests", "danger", "3 failed")
lint = Status("Lint", "success", "4s")
coverage = Section("Coverage by package", [bars])
bars = BarList([{label: "core", value: 88, display: "88%"}, {label: "server", value: 79, display: "79%"}, {label: "app", value: 64, display: "64%"}])
next = Actions([fix, failures])
fix = Button("Fix failing tests", "Fix the 3 failing unit tests", "primary")
failures = Button("Show failures", "Show me the 3 failing tests with their errors", "secondary")`,
  },
  {
    title: "Form that collects choices before acting",
    code: `root = Surface([intro, form])
intro = Text("Pick the options for the new package. I will scaffold it after you submit.", true)
form = Form([name, kind, runtime, tests], actions)
name = Input("name", "Package name", "e.g. plugin-genui")
kind = Segmented("kind", "Kind", ["Library", "CLI", "Service"], "Library")
runtime = Select("runtime", "Runtime", ["Bun", "Node 22", "Deno", "Cloudflare Workers", "Browser"], "Bun")
tests = Toggle("tests", "Add a test suite", true)
actions = Actions([create, cancel])
create = Button("Create package", "Create the package with these options", "primary")
cancel = Button("Cancel", "Do not create the package", "ghost")`,
  },
  {
    title: "Plan with a decision",
    code: `root = Surface([plan, decide])
plan = Section("Migration plan", [steps])
steps = Steps([{title: "Add the new column", state: "done"}, {title: "Backfill rows", detail: "1.2M rows, about 4 minutes", state: "current"}, {title: "Switch reads"}, {title: "Drop the old column"}])
decide = Section("Backfill strategy", [options], "Batch size trades speed for lock time.")
options = Group([fast, safe])
fast = Row("Fast", "10k rows per batch", "Backfill in batches of 10k rows")
safe = Row("Safe", "1k rows per batch", "Backfill in batches of 1k rows")`,
  },
  {
    title: "Data dashboard: lead with numbers, then charts",
    code: `root = Surface([kpis, trend, split, cache, activity])
kpis = Metrics([spend, requests, latency])
spend = Metric("Spend", "$1,284", "this week", 12.4, [142, 158, 171, 166, 190, 204, 253], true)
requests = Metric("Requests", "48.2k", "this week", 8.1, [5.9, 6.4, 6.8, 6.6, 7.1, 7.4, 8.0])
latency = Metric("p95 latency", "820 ms", "this week", -6.3, [910, 880, 870, 860, 850, 835, 820], true)
trend = Section("Daily cost by model", [costs])
costs = BarChart(days, [opus, sonnet], true, "currency")
days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
opus = Series("Opus", [92, 101, 110, 104, 121, 130, 168])
sonnet = Series("Sonnet", [50, 57, 61, 62, 69, 74, 85])
split = Columns([share, quota])
share = DonutChart([{label: "Opus", value: 826}, {label: "Sonnet", value: 458}], "$1,284", "currency")
quota = Meter("Monthly budget", 64, "$3,200 of $5,000", "auto")
cache = Gauge("Cache hit rate", 71, "71% of input tokens")
activity = Section("Requests by hour", [heat])
heat = Heatmap(["Mon", "Tue", "Wed"], ["9", "12", "15", "18"], [[120, 340, 410, 90], [140, 380, 450, 120], [100, 300, 390, 80]], "compact")`,
  },
] as const
