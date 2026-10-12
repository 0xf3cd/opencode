export * as GenUICatalog from "./catalog.js"

import { Schema } from "effect"
import { GenUILang } from "./lang.js"

// Each component is the schema of its rendered node. The props struct is the whole contract: its key order is the
// positional argument order, its types check what the model wrote, and the guide prints its signature from it. Append
// new props at the end so existing programs keep their meaning.
const component = <const Name extends string, const Props extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  props: Props,
) =>
  Schema.Struct({
    typeName: Schema.Literal(name),
    props: Schema.Struct(props),
    statementId: Schema.optional(Schema.String),
  }).annotate({ identifier: name, description })

/** An optional prop. `null` skips it positionally, e.g. `Metric("Spend", "$1,284", null, 12.4)`. */
const maybe = <S extends Schema.Top>(schema: S) => Schema.optional(Schema.NullOr(schema))

export const tones = ["neutral", "success", "warning", "danger", "info"] as const
export const stepStates = ["done", "current", "pending", "failed"] as const
export const buttonVariants = ["primary", "secondary", "ghost"] as const
export const formats = ["compact", "number", "currency", "percent", "duration", "bytes"] as const

/** What pressing a button or row does: `set`, `reset`, `reply` or `open`, evaluated when the user presses it. */
export const Action = Schema.declare((input: unknown): input is GenUILang.Action => input instanceof GenUILang.Action, {
  identifier: "Action",
})
const behaviour = maybe(Schema.Union([Schema.String, Action, Schema.Array(Action)]))
export const Tone = Schema.Literals(tones).annotate({ identifier: "Tone" })
export const Format = Schema.Literals(formats).annotate({ identifier: "Format" })
const format = maybe(Format)
const scalar = Schema.Union([Schema.String, Schema.Number])
const numbers = Schema.Array(Schema.NullOr(Schema.Number))
const items = Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.Number }))

export const Text = component(
  "Text",
  "Plain paragraph. Use Markdown instead for lists, links, emphasis or inline code.",
  {
    text: scalar,
    muted: maybe(Schema.Boolean),
  },
)
export const Markdown = component(
  "Markdown",
  "GitHub-flavored Markdown block for prose with lists, links, emphasis and inline code.",
  { text: Schema.String },
)
export const Code = component("Code", "Syntax-highlighted code block.", {
  code: Schema.String,
  language: maybe(Schema.String),
})
export const Divider = component("Divider", "Thin horizontal rule between unrelated blocks.", {})
export const Notice = component(
  "Notice",
  "Callout for one important fact: a warning, a failure, or a success the user must not miss. At most one per surface.",
  { title: Schema.String, description: maybe(Schema.String), tone: maybe(Tone) },
)
export const Status = component(
  "Status",
  "One line with a colored dot: a check, service or job state. detail is right-aligned muted text.",
  { label: Schema.String, tone: Tone, detail: maybe(Schema.String) },
)
export const Metric = component(
  "Metric",
  "One headline number inside Metrics. value is preformatted text; detail is a short muted note. delta is the percent change, colored green when up (red when inverse is true, for costs, latency or errors). trend is a short series drawn as a sparkline.",
  {
    label: Schema.String,
    value: scalar,
    detail: maybe(Schema.String),
    delta: maybe(Schema.Number),
    trend: maybe(Schema.Array(Schema.Number)),
    inverse: maybe(Schema.Boolean),
  },
)
export const Metrics = component("Metrics", "Grid of 2 to 4 Metric cells for headline numbers.", {
  items: Schema.Array(Metric),
})
export const Progress = component(
  "Progress",
  "Labeled progress bar. value is a percentage from 0 to 100; detail replaces the percentage text.",
  { label: Schema.String, value: Schema.Number, detail: maybe(Schema.String) },
)
export const BarList = component(
  "BarList",
  "Ranked horizontal bars for comparing magnitudes, largest first. display is the formatted value text.",
  { items: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.Number, display: maybe(Schema.String) })) },
)
export const Table = component(
  "Table",
  "Read-only table. rows is an array of rows; each row has one plain string or number per column.",
  { columns: Schema.Array(Schema.String), rows: Schema.Array(Schema.Array(scalar)) },
)
export const Steps = component("Steps", "Ordered checklist for a plan or pipeline.", {
  items: Schema.Array(
    Schema.Struct({ title: Schema.String, detail: maybe(Schema.String), state: maybe(Schema.Literals(stepStates)) }),
  ),
})
export const Row = component(
  "Row",
  "One row of a Group: a label with an optional right-aligned value. A row with an action is clickable, like a Button.",
  { label: Schema.String, value: maybe(Schema.String), action: behaviour },
)
export const Group = component("Group", "Card of Rows for key-value facts or a list of choices.", {
  rows: Schema.Array(Row),
})
export const Button = component(
  "Button",
  "action is text or actions. Text (default: label) is sent to you as the user's reply; inside a Form the form values go with it. Actions run in place, e.g. set($count, $count + 1). Use primary for the single main action.",
  { label: Schema.String, action: behaviour, variant: maybe(Schema.Literals(buttonVariants)) },
)
export const Link = component(
  "Link",
  "Button that opens an http(s) URL from the conversation or a tool result. Never invent URLs.",
  { label: Schema.String, url: Schema.String },
)
export const Actions = component("Actions", "Row of buttons.", { items: Schema.Array(Schema.Union([Button, Link])) })

const field = { name: Schema.String, label: Schema.String }
export const Input = component("Input", "Single-line text field. name is the key in the submitted values.", {
  ...field,
  placeholder: maybe(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const TextArea = component("TextArea", "Multi-line text field.", {
  ...field,
  placeholder: maybe(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const Select = component("Select", "Dropdown for one of many options (more than 4).", {
  ...field,
  options: Schema.Array(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const Choice = component("Choice", "Radio list for one of 2 to 4 options that need to be read side by side.", {
  ...field,
  options: Schema.Array(Schema.String),
  value: maybe(Schema.String),
  hint: maybe(Schema.String),
})
export const Segmented = component("Segmented", "Segmented control for one of 2 or 3 short options.", {
  ...field,
  options: Schema.Array(Schema.String),
  value: maybe(Schema.String),
})
export const Toggle = component("Toggle", "On/off switch.", {
  ...field,
  value: maybe(Schema.Boolean),
  hint: maybe(Schema.String),
})
export const Field = Schema.Union([Input, TextArea, Select, Choice, Segmented, Toggle]).annotate({
  identifier: "Field",
})
export type Field = typeof Field.Type
export const Form = component(
  "Form",
  "Fields with their submit actions. Exactly one primary Button submits; every field name is unique.",
  { fields: Schema.Array(Field), actions: Actions },
)

export const Series = component(
  "Series",
  "One named data series for a chart, one value per label. null leaves a gap.",
  {
    name: Schema.String,
    values: numbers,
  },
)
export const BarChart = component(
  "BarChart",
  "Vertical bars over categories or time, e.g. daily cost or requests per day. One Series draws monochrome bars; several draw grouped bars, or stacked when stacked is true.",
  { labels: Schema.Array(Schema.String), series: Schema.Array(Series), stacked: maybe(Schema.Boolean), format },
)
export const LineChart = component("LineChart", "Smooth trend lines over time. area shades under a single line.", {
  labels: Schema.Array(Schema.String),
  series: Schema.Array(Series),
  format,
  area: maybe(Schema.Boolean),
})
export const AreaChart = component(
  "AreaChart",
  "Filled trend areas over time; stacked shows how parts add up to a total.",
  { labels: Schema.Array(Schema.String), series: Schema.Array(Series), format, stacked: maybe(Schema.Boolean) },
)
export const ComboChart = component(
  "ComboChart",
  "Bars and a line on two scales over the same labels, e.g. tokens as bars and users as a line.",
  { labels: Schema.Array(Schema.String), bars: Series, line: Series, barFormat: format, lineFormat: format },
)
export const ProjectionChart = component(
  "ProjectionChart",
  "Actual values so far plus a projection to the end of the range, with an optional target or limit line. actual has null after the last known point; projected has null before it.",
  {
    labels: Schema.Array(Schema.String),
    actual: numbers,
    projected: numbers,
    target: maybe(Schema.Number),
    format,
    targetLabel: maybe(Schema.String),
  },
)
export const DonutChart = component(
  "DonutChart",
  "Parts of a whole, 2 to 8 items, with a legend. center is the headline figure shown above the ring, e.g. the formatted total.",
  { items, center: maybe(Schema.String), format },
)
export const ShareBar = component(
  "ShareBar",
  "One horizontal bar split into parts of a whole, with a legend. Compact alternative to DonutChart.",
  { items, format },
)
export const Meter = component(
  "Meter",
  "Capacity or quota used, value 0 to 100. tone auto turns warning at 70 and danger above 95.",
  {
    label: Schema.String,
    value: Schema.Number,
    detail: maybe(Schema.String),
    tone: maybe(Schema.Literals([...tones, "auto"])),
  },
)
export const Gauge = component(
  "Gauge",
  "Where one value sits on a 0 to 100 scale, e.g. a ratio, score or percentile.",
  {
    label: Schema.String,
    value: Schema.Number,
    detail: maybe(Schema.String),
  },
)
export const Pips = component("Pips", "Twenty-step rating meter for a score from 0 to 100, compact enough for lists.", {
  label: Schema.String,
  value: Schema.Number,
  detail: maybe(Schema.String),
  tone: maybe(Tone),
})
export const StatusStrip = component(
  "StatusStrip",
  "Timeline of discrete states, oldest first, e.g. CI runs, uptime checks or deploys. Each item has a label for its tooltip and a tone.",
  {
    items: Schema.Array(Schema.Struct({ label: Schema.String, tone: Tone })),
    start: maybe(Schema.String),
    end: maybe(Schema.String),
  },
)
export const Heatmap = component(
  "Heatmap",
  "Intensity grid, e.g. activity by weekday and hour or errors by service and day. values has one row per row label and one value per column.",
  { rows: Schema.Array(Schema.String), columns: Schema.Array(Schema.String), values: Schema.Array(numbers), format },
)
export const RadarChart = component("RadarChart", "Compare up to 4 series across 3 to 8 axes, each scored 0 to 100.", {
  axes: Schema.Array(Schema.String),
  series: Schema.Array(Series),
})
export const ScatterChart = component(
  "ScatterChart",
  "Points on two numeric axes to show correlation or trade-offs, e.g. cost against quality.",
  {
    points: Schema.Array(Schema.Struct({ label: Schema.String, x: Schema.Number, y: Schema.Number })),
    xLabel: Schema.String,
    yLabel: Schema.String,
    xFormat: format,
    yFormat: format,
  },
)
export const ComparisonRow = component(
  "ComparisonRow",
  "One row of a Comparison. best marks the winning cell: higher or lower numbers are better.",
  { label: Schema.String, values: Schema.Array(scalar), best: maybe(Schema.Literals(["higher", "lower"])) },
)
export const Comparison = component(
  "Comparison",
  "Side-by-side comparison of options, one column per option, with the best cell in each row highlighted.",
  { columns: Schema.Array(Schema.String), rows: Schema.Array(ComparisonRow) },
)

export const Block = Schema.Union([
  Text,
  Markdown,
  Code,
  Divider,
  Notice,
  Status,
  Metrics,
  Progress,
  BarList,
  Table,
  Steps,
  Group,
  Actions,
  Form,
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
]).annotate({ identifier: "Block" })
export type Block = typeof Block.Type
export const Columns = component(
  "Columns",
  "Two or three blocks side by side, e.g. a DonutChart next to Metrics. Stacks when the panel is narrow.",
  { children: Schema.Array(Block) },
)
export const Section = component("Section", "Titled group of blocks. Sections do not nest.", {
  title: Schema.String,
  children: Schema.Array(Schema.Union([Block, Columns])),
  description: maybe(Schema.String),
})
export const Surface = component("Surface", "The root. Blocks and Sections stack vertically.", {
  children: Schema.Array(Schema.Union([Block, Columns, Section])),
})
export interface Surface extends Schema.Schema.Type<typeof Surface> {}

/** Components in the order the guide teaches them, with the advice that applies to each group. */
export const groups = [
  { name: "Layout", components: [Surface, Section, Columns], notes: [] },
  { name: "Content", components: [Text, Markdown, Code, Divider, Notice, Status], notes: [] },
  { name: "Data", components: [Metrics, Metric, Progress, BarList, Table, Steps, Group, Row], notes: [] },
  {
    name: "Charts",
    components: [
      Series,
      BarChart,
      LineChart,
      AreaChart,
      ComboChart,
      ProjectionChart,
      DonutChart,
      ShareBar,
      RadarChart,
      ScatterChart,
      Heatmap,
    ],
    notes: [
      "Prefer a chart over a table whenever numbers form a trend, a ranking, a share or a distribution.",
      "Pass raw numbers and pick a format: compact (1.2k, 3.4M), number, currency (USD), percent (values already 0 to 100), duration (milliseconds) or bytes.",
      "Keep labels short (e.g. Mon, 3/14, 14:00); about 7 to 31 labels read best.",
    ],
  },
  { name: "Meters", components: [Meter, Gauge, Pips, StatusStrip, Comparison, ComparisonRow], notes: [] },
  { name: "Actions", components: [Actions, Button, Link], notes: [] },
  {
    name: "Forms",
    components: [Form, Input, TextArea, Select, Choice, Segmented, Toggle],
    notes: ["Field values reach you only when the user presses a Button inside the Form."],
  },
] as const

export const catalog = GenUILang.catalog(
  groups.flatMap((group): readonly Schema.Decoder<unknown>[] => group.components),
)

/** Checks a finished program against this catalog. */
export const check = (code: string) => GenUILang.check(GenUILang.parse(code), catalog, Surface)

/** Programs the guide shows the model. Each checks clean. */
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
  {
    title: "Interactive review: state that updates in place, then one reply",
    code: `root = Surface([counts, status, actions])
$approved = 0
$total = 4
counts = Metrics([done, left])
done = Metric("Approved", $approved + " of " + $total)
left = Metric("Remaining", $total - $approved)
status = $approved == $total ? ready : review
ready = Notice("All changes approved", "Apply them when you are ready.", "success")
review = Progress("Review", $approved / $total * 100)
actions = Actions([approve, undo, apply])
approve = Button("Approve next", set($approved, $approved < $total ? $approved + 1 : $total), "primary")
undo = Button("Undo", set($approved, $approved > 0 ? $approved - 1 : 0), "ghost")
apply = Button("Apply approved", reply("Apply the " + $approved + " approved changes"), "secondary")`,
  },
] as const
