import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { currentToolInput } from "./current-tool-state"
import { partialStringFields } from "./partial-json"

/**
 * A tool call's input, including while it streams: once the JSON is incomplete, its string arguments as written so
 * far. Only tools that opt into streaming receive partial JSON; every other call reads as before.
 */
export function currentStreamingInput(tool: SessionMessageAssistantTool) {
  const input = currentToolInput(tool)

  if (tool.state.status !== "streaming" || !tool.state.input || Object.keys(input).length > 0) return input

  return partialStringFields(tool.state.input)
}
