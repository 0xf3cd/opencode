import { describe, expect, test } from "bun:test"
import type { SessionMessageAssistant, SessionMessageIdle, SessionMessageInfo } from "@opencode/client/promise"
import { agentOrbState, lastOutcome, runningStep, type SessionActivity } from "./agent-orb-state"

const quiet: SessionActivity = { attention: false, running: false, subagents: false, shells: false }

type Part = SessionMessageAssistant["content"][number]

const assistant = (content: Part[], completed?: number): SessionMessageAssistant => ({
  id: "msg",
  type: "assistant",
  time: { created: 0, completed },
  agent: "build",
  model: { id: "model", providerID: "opencode" },
  content,
})

const states = {
  streaming: { status: "streaming", input: "" },
  running: { status: "running", input: {}, metadata: {} },
  completed: { status: "completed", input: {}, content: [{ type: "text", text: "ok" }] },
} satisfies Record<string, Extract<Part, { type: "tool" }>["state"]>

const tool = (name: string, status: keyof typeof states): Part => ({
  type: "tool",
  id: name,
  name,
  time: { created: 0 },
  state: states[status],
})

describe("agentOrbState", () => {
  test("a quiet session is idle", () => {
    expect(agentOrbState(quiet)).toBe("idle")
  })

  test("a running step maps to what it is doing", () => {
    expect(agentOrbState({ ...quiet, running: true })).toBe("thinking")
    expect(agentOrbState({ ...quiet, running: true, step: "text" })).toBe("streaming")
    expect(agentOrbState({ ...quiet, running: true, step: { tool: "read" } })).toBe("tool")
    expect(agentOrbState({ ...quiet, running: true, step: { tool: "shell" } })).toBe("shell")
    expect(agentOrbState({ ...quiet, running: true, step: { tool: "subagent" } })).toBe("handoff")
  })

  test("a waiting permission or question outranks everything", () => {
    expect(agentOrbState({ ...quiet, attention: true, running: true, subagents: true, finished: "failed" })).toBe(
      "waiting",
    )
  })

  test("background work keeps the orb busy after the session's own step ends", () => {
    expect(agentOrbState({ ...quiet, subagents: true, shells: true })).toBe("handoff")
    expect(agentOrbState({ ...quiet, shells: true })).toBe("shell")
    expect(agentOrbState({ ...quiet, shells: true, finished: "succeeded" })).toBe("shell")
  })

  test("the finale shows how the run ended; an interruption goes quiet", () => {
    expect(agentOrbState({ ...quiet, finished: "succeeded" })).toBe("done")
    expect(agentOrbState({ ...quiet, finished: "failed" })).toBe("failed")
    expect(agentOrbState({ ...quiet, finished: "interrupted" })).toBe("idle")
  })
})

describe("runningStep", () => {
  const user: SessionMessageInfo[] = []

  test("no open assistant message means no step", () => {
    expect(runningStep(user)).toBeUndefined()
    expect(runningStep([assistant([{ type: "text", text: "done" }], 10)])).toBeUndefined()
  })

  test("a running or streaming tool call is the step", () => {
    expect(runningStep([assistant([{ type: "text", text: "Let me look" }, tool("read", "running")])])).toEqual({
      tool: "read",
    })
    expect(runningStep([assistant([tool("shell", "streaming")])])).toEqual({ tool: "shell" })
  })

  test("finished tool calls do not count; trailing text is streaming", () => {
    expect(runningStep([assistant([tool("read", "completed"), { type: "text", text: "Found it" }])])).toBe("text")
    expect(runningStep([assistant([tool("read", "completed"), { type: "reasoning", text: "" }])])).toBeUndefined()
  })
})

describe("lastOutcome", () => {
  test("reads the latest idle marker", () => {
    const idle = (outcome: SessionMessageIdle["outcome"]): SessionMessageIdle => ({
      id: outcome,
      type: "idle",
      outcome,
      time: { created: 0 },
    })

    expect(lastOutcome([])).toBeUndefined()
    expect(lastOutcome([idle("failed"), assistant([]), idle("succeeded")])).toBe("succeeded")
  })
})
