import type { SessionMessageAssistantTool } from "@opencode/client/promise"
import { currentToolInput } from "./current-tool-state"
import { partialStringFields } from "./partial-json"

/**
 * A tool call's input, including while it streams: while the JSON is incomplete, its string arguments as written so
 * far. For tools whose renderer draws arguments as they arrive.
 */
export function currentStreamingInput(tool: SessionMessageAssistantTool) {
  const input = currentToolInput(tool)

  if (tool.state.status !== "streaming" || !tool.state.input || Object.keys(input).length > 0) return input

  return partialStringFields(tool.state.input)
}
