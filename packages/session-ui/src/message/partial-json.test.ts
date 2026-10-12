import { describe, expect, test } from "bun:test"
import { partialStringFields } from "./partial-json"

describe("partialStringFields", () => {
  test.each([
    ["nothing yet", "", {}],
    ["an open object", "{", {}],
    ["a key still streaming", '{"tit', {}],
    ["a value still streaming", '{"title":"Release re', { title: "Release re" }],
    ["completed fields before a streaming one", '{"title":"Plan","code":"root = Surface([a])\\na = Te', {
      title: "Plan",
      code: "root = Surface([a])\na = Te",
    }],
    ["escapes, unicode and quotes", '{"code":"a \\"b\\" \\u00e9 \\\\ c"}', { code: 'a "b" é \\ c' }],
    ["an escape cut in half", '{"code":"line\\', { code: "line" }],
    ["a unicode escape cut in half", '{"code":"x\\u00', { code: "x" }],
    ["non-string values skipped", '{"count":3,"nested":{"a":"}"},"list":["x"],"code":"ok"}', { code: "ok" }],
  ])("%s", (_, raw, expected) => {
    expect(partialStringFields(raw)).toEqual(expected)
  })
})
