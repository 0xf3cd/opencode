import { describe, expect, test } from "bun:test"
import { Option, Schema } from "effect"
import { GenUILibrary } from "../src/library"

describe("GenUILibrary", () => {
  // The renderer decodes the parser's tree with the Effect element schemas; a prop added to the zod library but not
  // to its element schema makes a guide example fail here.
  test.each(GenUILibrary.examples.map((example) => [example.title, example.code]))("%s renders", (_, code) => {
    const parsed = GenUILibrary.parse(code)

    expect(parsed.meta.errors).toEqual([])
    expect(parsed.meta.unresolved).toEqual([])
    expect(parsed.meta.orphaned).toEqual([])
    const decoded = Schema.decodeUnknownOption(GenUILibrary.SurfaceElement)(parsed.root)

    expect(Option.isSome(decoded)).toBe(true)
    // A misplaced block decodes to null and silently disappears; examples must not teach that.
    expect(JSON.stringify(Option.getOrUndefined(decoded))).not.toContain("null")
  })

  test("every component in the library has an element schema", () => {
    const names = Object.keys(GenUILibrary.library.toSpec().components).toSorted()
    const decoded = new Set<string>(
      [
        ...GenUILibrary.BlockElement.members,
        GenUILibrary.SectionElement,
        GenUILibrary.ColumnsElement,
        GenUILibrary.SeriesElement,
        GenUILibrary.ComparisonRowElement,
        GenUILibrary.SurfaceElement,
        GenUILibrary.MetricElement,
        GenUILibrary.RowElement,
        GenUILibrary.ButtonElement,
        GenUILibrary.LinkElement,
        ...GenUILibrary.FieldElement.members,
      ].map((member) => member.fields.typeName.literal),
    )

    expect([...decoded].toSorted()).toEqual(names)
  })
})
