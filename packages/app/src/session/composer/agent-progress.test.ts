import { describe, expect, test } from "bun:test"
import type { SessionInfo, SessionMessageInfo } from "@opencode/client/promise"
import { agentProgressCounts, agentProgressItems, formatElapsed } from "./agent-progress"

const owner = "ses_owner"

// SAFETY: fixtures fill the fields agentProgressItems reads; the rest of SessionInfo is never touched.
const child = (id: string, input: Partial<SessionInfo> & { created: number }): SessionInfo =>
  ({
    id,
    parentID: owner,
    projectID: "prj",
    agent: "general",
    title: `Task ${id}`,
    cost: 0,
    tokens: {},
    location: { directory: "/repo" },
    ...input,
    time: { created: input.created, updated: input.created, ...input.time },
  }) as SessionInfo

const items = (input: {
  sessions: SessionInfo[]
  running?: string[]
  needsYou?: string[]
  messages?: SessionMessageInfo[]
  errors?: Record<string, string>
}) =>
  agentProgressItems({
    owner,
    sessions: input.sessions,
    status: (id) => (input.running?.includes(id) ? "running" : "idle"),
    needsYou: (id) => !!input.needsYou?.includes(id),
    messages: input.messages ?? [],
    childError: (id) => input.errors?.[id],
    shells: [],
  })

describe("agentProgressItems", () => {
  test("reads each child's state from its status, requests and outcome", () => {
    const result = items({
      sessions: [
        child("a", { created: 1 }),
        child("b", { created: 2 }),
        child("c", { created: 3, outcome: "failed", time: { created: 3, updated: 9, idle: 9 } }),
        child("d", { created: 4, outcome: "succeeded", time: { created: 4, updated: 8, idle: 8 } }),
        child("e", { created: 5, outcome: "interrupted", time: { created: 5, updated: 7, idle: 7 } }),
      ],
      running: ["a", "b"],
      needsYou: ["b"],
      errors: { c: "Provider rate limit" },
    })

    expect(result.map((item) => [item.key, item.state])).toEqual([
      ["a", "running"],
      ["b", "needs-you"],
      ["c", "failed"],
      ["d", "done"],
      ["e", "stopped"],
    ])
    expect(result.find((item) => item.key === "c")?.error).toBe("Provider rate limit")
    expect(agentProgressCounts(result)).toEqual({ total: 5, running: 1, needsYou: 1, failed: 1, done: 2 })
  })

  test("keeps only the batch since the last moment nothing ran", () => {
    const result = items({
      sessions: [
        child("old", { created: 1, outcome: "succeeded", time: { created: 1, updated: 5, idle: 5 } }),
        child("new", { created: 10 }),
        child("newer", { created: 12, outcome: "succeeded", time: { created: 12, updated: 14, idle: 14 } }),
      ],
      running: ["new"],
    })

    expect(result.map((item) => item.key)).toEqual(["new", "newer"])
  })

  test("settles a background call from its completion notice when the child isn't loaded", () => {
    const result = items({
      sessions: [],
      // SAFETY: an assistant call and its synthetic completion notice, shaped as the server sends them.
      messages: [
        {
          id: "msg_a",
          type: "assistant",
          agent: "build",
          model: { id: "alpha", providerID: "test" },
          content: [
            {
              type: "tool",
              id: "prt_call",
              name: "subagent",
              state: {
                status: "completed",
                input: { description: "Trace voice settings", agent: "explore" },
                content: [{ type: "text", text: "started" }],
                metadata: { sessionID: "ses_bg", status: "running" },
              },
              time: { created: 100, completed: 101 },
            },
            {
              type: "tool",
              id: "prt_starting",
              name: "subagent",
              state: { status: "streaming", input: "" },
              time: { created: 102 },
            },
          ],
          time: { created: 99 },
        },
        {
          id: "msg_notice",
          type: "synthetic",
          text: '<subagent sessionID="ses_bg" state="error" description="Trace voice settings">\nProvider rate limit\n</subagent>',
          metadata: { source: "subagent", childID: "ses_bg", state: "error" },
          time: { created: 150 },
        },
      ] as SessionMessageInfo[],
    })

    expect(result).toMatchObject([
      { key: "ses_bg", state: "failed", title: "Trace voice settings", agent: "explore", error: "Provider rate limit" },
      { key: "prt_starting", state: "starting", target: "prt_starting" },
    ])
  })
})

test("formatElapsed", () => {
  expect([formatElapsed(38_000), formatElapsed(72_000), formatElapsed(3_840_000)]).toEqual(["38s", "1m 12s", "1h 4m"])
})
