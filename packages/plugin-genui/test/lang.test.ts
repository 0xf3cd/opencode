import { describe, expect, test } from "bun:test"
import { GenUICatalog } from "../src/catalog"
import { GenUIGuide } from "../src/guide"
import { GenUILang } from "../src/lang"

const render = (program: GenUILang.Program, state: GenUILang.State, memory?: Map<string, unknown>) =>
  GenUILang.render(program, { catalog: GenUICatalog.catalog, root: GenUICatalog.Surface, state, memory })

/** Statement IDs of every rendered node in a tree. */
const rendered = (node: unknown): string[] => {
  if (Array.isArray(node)) return node.flatMap(rendered)
  if (node === null || typeof node !== "object") return []
  const id = "statementId" in node && typeof node.statementId === "string" ? [node.statementId] : []
  return [...id, ...Object.values(node).flatMap(rendered)]
}

describe("GenUILang", () => {
  test.each(GenUICatalog.examples.map((example) => [example.title, example.code]))("%s checks clean", (_, code) => {
    const checked = GenUICatalog.check(code)

    expect(checked.issues).toEqual([])
    expect(checked.root?.typeName).toBe("Surface")
  })

  // The surface is drawn from every prefix the model has written so far. No prefix may throw, and a block that has
  // appeared keeps appearing while later lines stream in.
  test.each(GenUICatalog.examples.map((example) => [example.title, example.code]))("%s streams", (_, code) => {
    const parse = GenUILang.parser()
    const memory = new Map<string, unknown>()
    const start = GenUILang.initial(GenUILang.parse(code), GenUICatalog.catalog).state
    const seen = new Set<string>()

    for (let length = 1; length <= code.length; length++) {
      const root = render(parse(code.slice(0, length), true), start, memory).root
      const ids = new Set(rendered(root))
      expect([...seen].filter((id) => !ids.has(id))).toEqual([])
      ids.forEach((id) => seen.add(id))
    }
    expect(rendered(render(GenUILang.parse(code), start).root).toSorted()).toEqual([...seen].toSorted())
  })

  test("reports what an author can fix, by statement", () => {
    const issues = GenUICatalog.check(`root = Surface([count, chart, row, missing, $nope])
$count = 0
count = Metric("Clicks", $cuont)
chart = BarChartt([1, 2, 3])
row = Row("Label")
spare = Text("never used")
plus = Button("+1", set(count, 1))`).issues

    expect(issues.map((issue) => `${issue.statement}: ${issue.message}`)).toEqual([
      "count: $cuont is not declared. Declare it with $cuont = <initial value> (declared: $count)",
      "count: Metric needs value: Metric(label: string, value: string | number, detail?: string, delta?: number, trend?: number[], inverse?: boolean)",
      "chart: BarChartt is not a component. Did you mean BarChart?",
      "root: missing is used but never defined",
      "root: $nope is not declared. Declare it with $nope = <initial value> (declared: $count)",
      "root: Surface.children takes Block | Columns | Section, not Row; Row goes in Group",
      "spare: spare is defined but nothing under root uses it, so it does not render",
      "plus: set takes a $name: set($name, value)",
      "plus: plus is defined but nothing under root uses it, so it does not render",
    ])
    expect(issues.find((issue) => issue.statement === "chart")?.line).toBe(4)
  })

  test("reports syntax and type errors with the line they are on", () => {
    const issues = GenUICatalog.check(`root = Surface([a, b])\na = Text("open\nb = Progress("Done", "most")`).issues

    expect(issues.map((issue) => `${issue.line}: ${issue.message}`)).toEqual([
      "2: A string is not closed. Strings must end on the line they start on.",
      "1: a is used but never defined",
      '3: Progress.value: Expected number, got "most"',
    ])
  })

  test("buttons update state in place and reply with it", () => {
    const code = GenUICatalog.examples.find((example) => example.title.startsWith("Interactive"))?.code ?? ""
    const program = GenUILang.parse(code)
    const state = new Map(GenUILang.initial(program, GenUICatalog.catalog).state)
    const actions = () => {
      const root = render(program, state).root
      const block = root?.props.children.find((child) => child.typeName === "Actions")
      return block?.typeName === "Actions" ? block.props.items : []
    }
    const press = (label: string) => {
      const button = actions().find((item) => item.typeName === "Button" && item.props.label === label)
      const action = button?.typeName === "Button" ? button.props.action : undefined
      if (!(action instanceof GenUILang.Action)) throw new Error(`${label} has no action`)
      return GenUILang.perform(action, program, GenUICatalog.catalog, state)
    }

    const approve = press("Approve next")
    expect(approve).toEqual({ type: "set", name: "$approved", value: 1 })
    if (approve?.type === "set") state.set(approve.name, approve.value)
    expect(press("Apply approved")).toEqual({ type: "reply", message: "Apply the 1 approved changes" })
    state.set("$approved", 4)
    expect(render(program, state).root?.props.children.map((child) => child.typeName)).toEqual([
      "Metrics",
      "Notice",
      "Actions",
    ])
  })

  test("the guide prints every component's typed signature", () => {
    expect(GenUIGuide.text).toContain(
      "`Metric(label: string, value: string | number, detail?: string, delta?: number, trend?: number[], inverse?: boolean)`",
    )
    expect(GenUIGuide.text).toContain(
      '`Button(label: string, action?: string | Action | Action[], variant?: "primary" | "secondary" | "ghost")`',
    )
    expect(GenUIGuide.text).toContain("`Surface(children: (Block | Columns | Section)[])`")
    GenUICatalog.catalog.components.forEach((component) =>
      expect(GenUIGuide.text).toContain(`\`${GenUILang.signature(component)}\``),
    )
  })
})
