import type { SessionMessageInfo } from "@opencode/client/promise"
import type { SessionDocument } from "@opencode/session-ui/document"
import { CURRENT_SESSION_ID, STORY_MODEL, STORY_TIME, editThenTestDocument } from "@opencode/session-ui/storybook"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { For, onCleanup, onMount } from "solid-js"
import { createStore, produce } from "solid-js/store"
import { agentGlyphTuning } from "@/session/agent-glyph/agent-glyph"
import { SessionPreview } from "@/session/story-model"
import type { AgentProgressItem, AgentProgressState } from "./agent-progress"
import { agentChipTuning } from "./agent-progress-chip"

const timelineDetail = timelinePresets[2].value

const tasks = [
  "Review photo sheet polish",
  "Audit drag-to-pin gesture",
  "Record synced before/after clips",
  "Fix camera double start",
  "Trace voice settings rebase",
  "Check model picker layout",
  "Profile timeline scroll jank",
  "Write release notes draft",
  "Verify TestFlight build 448",
  "Port activity glyph to web",
  "Find flaky composer test",
  "Compare task panels",
  "Reproduce sheet white flash",
  "Search for stale feature flags",
  "Measure cold start",
  "Update board shipped notes",
  "Check RTL composer spacing",
  "Draft settings cleanup plan",
  "Inspect permission dock copy",
]

const agents = ["general", "explore", "review"]

const models = ["Alpha", "Beta"]

const NOW = STORY_TIME + 600_000

const item = (index: number, state: AgentProgressState, input: Partial<AgentProgressItem> = {}): AgentProgressItem => ({
  key: `ses_story_${index}`,
  type: "subagent",
  state,
  title: tasks[index % tasks.length]!,
  agent: agents[index % agents.length],
  model: { id: models[index % models.length]!, providerID: "story" },
  sessionID: `ses_story_${index}`,
  target: `ses_story_${index}`,
  started: NOW - 38_000 - index * 17_000,
  ended: state === "done" || state === "failed" || state === "stopped" ? NOW - index * 3_000 : undefined,
  error: state === "failed" ? "Provider rate limit" : undefined,
  ...input,
})

const document: SessionDocument = {
  sessionID: CURRENT_SESSION_ID,
  status: { type: "busy" },
  diffs: [],
  messages: [
    ...editThenTestDocument.messages,
    {
      id: "msg_user_agents",
      type: "user",
      text: "Check on the board and keep the agents moving.",
      time: { created: STORY_TIME + 300_000 },
      metadata: { agent: "build", model: STORY_MODEL },
    },
    {
      id: "msg_assistant_agents",
      type: "assistant",
      agent: "build",
      model: STORY_MODEL,
      content: [{ type: "text", text: "I'll split the review across subagents and report back when they finish." }],
      time: { created: STORY_TIME + 300_500 },
    },
  ] satisfies SessionMessageInfo[],
}

const fixture =
  (items: AgentProgressItem[], open = false) =>
  () => (
    <SessionPreview
      title="Keep the agents moving"
      description="opencode · agent progress"
      document={document}
      timelineDetail={timelineDetail}
      activity={{ items, open: open || undefined, now: () => NOW }}
    />
  )

const many = (running: number, done: number, extra: AgentProgressItem[] = []) => [
  ...extra,
  ...Array.from({ length: running }, (_, index) => item(index + extra.length, "running")),
  ...Array.from({ length: done }, (_, index) => item(index + extra.length + running, "done")),
]

// Scripted with `agent-chip-story` events on `document` so a recording can drive it, and with the toolbar by hand.
function LiveAgents() {
  const [story, setStory] = createStore<{ items: AgentProgressItem[]; open: boolean; next: number }>({
    items: [],
    open: false,
    next: 0,
  })

  const add = (count: number) =>
    setStory(
      produce((draft) => {
        for (let i = 0; i < count; i++) {
          const index = draft.next++
          draft.items.push(item(index, "running", { started: Date.now() - (index % 4) * 9_000 }))
        }
      }),
    )

  const settle = (state: AgentProgressState, from: AgentProgressState[] = ["running"]) =>
    setStory(
      produce((draft) => {
        const target = draft.items.find((value) => from.includes(value.state))

        if (!target) return
        target.state = state
        target.ended = state === "running" || state === "needs-you" ? undefined : Date.now()
        target.error = state === "failed" ? "Provider rate limit" : undefined
      }),
    )

  const speed = (value = 1) => {
    agentChipTuning.timeScale = value
    agentGlyphTuning.speed = value
  }

  const finishAll = () =>
    setStory(
      produce((draft) =>
        draft.items.forEach((value) => {
          if (value.state !== "running" && value.state !== "needs-you") return
          value.state = "done"
          value.ended = Date.now()
        }),
      ),
    )

  const actions = new Map<string, (value?: number) => void>([
    ["reset", () => setStory({ items: [], open: false, next: 0 })],
    ["add", (value) => add(value ?? 1)],
    ["finish", () => settle("done", ["running", "needs-you"])],
    ["fail", () => settle("failed")],
    ["needs", () => settle("needs-you")],
    ["resolve", () => settle("running", ["needs-you"])],
    ["finishAll", finishAll],
    ["clear", () => setStory("items", [])],
    ["open", () => setStory("open", true)],
    ["close", () => setStory("open", false)],
    ["speed", speed],
  ])

  onMount(() => {
    const run = (event: Event) => {
      if (!(event instanceof CustomEvent)) return
      actions.get(event.detail.action)?.(event.detail.value)
    }

    window.document.addEventListener("agent-chip-story", run)
    onCleanup(() => {
      window.document.removeEventListener("agent-chip-story", run)
      speed(1)
    })
  })

  return (
    <>
      <SessionPreview
        title="Keep the agents moving"
        description="opencode · agent progress"
        document={document}
        timelineDetail={timelineDetail}
        activity={{
          items: story.items,
          open: story.open,
          onOpenChange: (open) => setStory("open", open),
          onStop: (value) =>
            setStory(
              "items",
              (entry) => entry.key === value.key,
              produce((draft) => {
                draft.state = "stopped"
                draft.ended = Date.now()
              }),
            ),
        }}
      />
      <div data-story-toolbar class="fixed end-3 top-3 z-50 flex flex-wrap gap-1">
        <For
          each={
            [
              ["+1", () => add(1)],
              ["+3", () => add(3)],
              ["Finish", () => settle("done", ["running", "needs-you"])],
              ["Fail", () => settle("failed")],
              ["Needs you", () => settle("needs-you")],
              ["Resolve", () => settle("running", ["needs-you"])],
              ["All done", finishAll],
              ["Clear", () => setStory("items", [])],
              ["1×", () => speed(1)],
              ["0.25×", () => speed(0.25)],
            ] as const
          }
        >
          {([label, run]) => (
            <button
              type="button"
              class="h-6 rounded-[4px] bg-v2-background-bg-layer-02 px-2 text-[11px] font-[530] text-v2-text-text-base hover:bg-v2-overlay-simple-overlay-hover"
              onClick={run}
            >
              {label}
            </button>
          )}
        </For>
      </div>
    </>
  )
}

export default {
  title: "OpenCode/Session/Agent progress chip",
  id: "session-agent-progress-chip",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "The current batch of subagents above the production Composer: a progress chip that morphs into a panel of rows, the chip staying as its bottom row.",
      },
    },
  },
}

export const One = { render: fixture([item(0, "running")]) }

export const Three = { render: fixture(many(3, 0)) }

const nineteen = () => many(3, 14, [item(0, "needs-you"), item(1, "failed")])

export const Nineteen = { render: fixture(nineteen()) }

export const NineteenOpen = { render: fixture(nineteen(), true) }

export const Failed = { render: fixture(many(2, 3, [item(0, "failed")])) }

export const NeedsYou = { render: fixture(many(2, 0, [item(0, "needs-you")])) }

export const NeedsYouOpen = { render: fixture(many(2, 0, [item(0, "needs-you")]), true) }

export const AllDone = { render: fixture(many(0, 5)) }

export const Live = { render: () => <LiveAgents /> }
