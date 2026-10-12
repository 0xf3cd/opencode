import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { currentStreamingInput } from "./streaming-input"

const tool = (input: string) =>
  ({
    type: "tool",
    id: "tool_streaming",
    name: "genui_render",
    state: { status: "streaming", input },
    time: { created: 1 },
  }) satisfies SessionMessageAssistantTool

describe("currentStreamingInput", () => {
  test("shows string arguments as they stream", () => {
    expect(currentStreamingInput(tool('{"title":"Plan","code":"root = Surface([a])\\na = Te'))).toEqual({
      title: "Plan",
      code: "root = Surface([a])\na = Te",
    })
  })

  test("decodes complete JSON as usual", () => {
    expect(currentStreamingInput(tool('{"title":"Plan","count":2}'))).toEqual({ title: "Plan", count: 2 })
  })
})
