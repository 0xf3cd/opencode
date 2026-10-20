import type { SessionMessageInfo } from "@opencode/client/promise"
import type { AgentOrbState } from "@opencode/session-ui/v2/agent-orb"

export type SessionActivity = {
  // A permission or question is waiting on the user.
  attention: boolean
  // The session itself is running a step.
  running: boolean
  // What the running step is doing right now, from its latest assistant message.
  step?: "text" | { tool: string }
  // A child session (subagent) is still running.
  subagents: boolean
  // A shell started by the session is still running in the background.
  shells: boolean
  // How the last run ended, while its finale still shows.
  finished?: "succeeded" | "failed" | "interrupted"
}

// Same order as the iOS app's summary: the user's turn first, then the work in front of the agent, then
// background work, then the finale. An interrupted run goes quiet without a flash.
export function agentOrbState(activity: SessionActivity): AgentOrbState {
  if (activity.attention) return "waiting"

  if (activity.running) return stepState(activity.step)

  if (activity.subagents) return "handoff"

  if (activity.shells) return "shell"

  if (activity.finished === "succeeded") return "done"

  if (activity.finished === "failed") return "failed"

  return "idle"
}

function stepState(step: SessionActivity["step"]): AgentOrbState {
  if (step === undefined) return "thinking"

  if (step === "text") return "streaming"

  if (step.tool === "shell") return "shell"

  if (step.tool === "subagent") return "handoff"

  return "tool"
}

// The running step of a transcript: a running tool call, or text still streaming as the latest part.
export function runningStep(messages: readonly SessionMessageInfo[]): SessionActivity["step"] {
  const assistant = messages.findLast((message) => message.type === "assistant")

  if (assistant?.type !== "assistant" || assistant.time.completed !== undefined) return undefined

  const tool = assistant.content.findLast(
    (part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "streaming"),
  )

  if (tool?.type === "tool") return { tool: tool.name }

  return assistant.content.at(-1)?.type === "text" ? "text" : undefined
}

// How the latest run ended, from the idle marker the client records when an execution finishes.
export function lastOutcome(messages: readonly SessionMessageInfo[]) {
  const idle = messages.findLast((message) => message.type === "idle")

  return idle?.type === "idle" ? idle.outcome : undefined
}
