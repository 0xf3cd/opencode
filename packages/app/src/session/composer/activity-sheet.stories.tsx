import type { SessionMessageAssistantTool, SessionMessageInfo } from "@opencode/client/promise"
import type { SessionDocument } from "@opencode/session-ui/document"
import {
  CURRENT_SESSION_ID,
  STORY_MODEL,
  STORY_TIME,
  editThenTestDocument,
  largeCompletedDocument,
} from "@opencode/session-ui/storybook"
import { timelinePresets } from "@opencode/session-ui/timeline/detail"
import { motionTuning } from "@opencode/ui/motion-tuning"
import { createMemo, For, onCleanup, onMount, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { SessionPreview } from "@/session/story-model"
import { composerSheetSpring, type SessionActivitySubagent } from "./activity-sheet"

// The app's default timeline preset.
const timelineDetail = timelinePresets[2].value

// Fictional work for fictional models.
const pool = [
  { agent: "explore", description: "Map how the Alpha router retries a dropped stream" },
  { agent: "general", description: "Reproduce the Beta tokenizer drift on long prompts" },
  { agent: "explore", description: "Find every caller of the session inbox projection" },
  { agent: "review", description: "Review the Alpha cache eviction patch" },
]

type Agent = { id: string; index: number; started: number; finished: boolean }

function document_(agents: Agent[]): SessionDocument {
  const tools = agents.map((value): SessionMessageAssistantTool => {
    const task = pool[value.index % pool.length]!
    const input = { agent: task.agent, description: task.description, prompt: task.description }

    return {
      type: "tool",
      id: `tool_${value.id}`,
      name: "subagent",
      state: value.finished
        ? {
            status: "completed",
            input,
            content: [{ type: "text", text: "Done. Nothing blocking." }],
            metadata: { sessionID: value.id, status: "completed" },
          }
        : { status: "running", input, metadata: { sessionID: value.id } },
      time: { created: STORY_TIME + 301_000 + value.index * 1_000, ran: STORY_TIME + 301_100 + value.index * 1_000 },
    }
  })

  const done = agents.length > 0 && agents.every((value) => value.finished)

  const messages: SessionMessageInfo[] = [
    ...editThenTestDocument.messages,
    ...largeCompletedDocument.messages.slice(-8),
    {
      id: "msg_user_sheet",
      type: "user",
      text: "Look into the Alpha retry bug and the Beta tokenizer drift in parallel, then summarize.",
      time: { created: STORY_TIME + 300_000 },
      metadata: { agent: "build", model: STORY_MODEL },
    },
    {
      id: "msg_assistant_sheet",
      type: "assistant",
      agent: "build",
      model: STORY_MODEL,
      content: [
        { type: "text", text: "I'll hand each investigation to a subagent and report back as they finish." },
        ...tools,
        ...(done ? [{ type: "text" as const, text: "All investigations are back. Summary below." }] : []),
      ],
      time: { created: STORY_TIME + 300_500, completed: done ? STORY_TIME + 360_000 : undefined },
    },
  ]

  return { sessionID: CURRENT_SESSION_ID, messages, status: done ? { type: "idle" } : { type: "busy" }, diffs: [] }
}

function SheetStory(props: { fade: boolean; agents: number; open: boolean; variant?: "band" | "inline" }) {
  const [state, setState] = createStore({
    agents: Array.from({ length: props.agents }, (_, index) => ({
      id: `ses_child_${index}`,
      index,
      started: Date.now() - (42 - index * 25) * 1000,
      finished: false,
    })) as Agent[],
    next: props.agents,
    open: props.open,
    fade: props.fade,
    variant: props.variant ?? "band",
    action: "",
    panel: false,
  })
  let timeline: HTMLDivElement | undefined
  let panel: HTMLDivElement | undefined
  let unmountPanel: (() => void) | undefined

  const value = createMemo(() => document_(state.agents))
  const subagents = createMemo(() =>
    state.agents
      .filter((value) => !value.finished)
      .map(
        (value): SessionActivitySubagent => ({
          key: value.id,
          type: "subagent",
          label: pool[value.index % pool.length]!.description,
          agent: pool[value.index % pool.length]!.agent,
          sessionID: value.id,
          target: value.id,
          started: value.started,
        }),
      ),
  )

  const start = () =>
    setState((current) => ({
      agents: [
        ...current.agents,
        { id: `ses_child_${current.next}`, index: current.next, started: Date.now(), finished: false },
      ],
      next: current.next + 1,
    }))

  const finish = () => {
    const index = state.agents.findIndex((value) => !value.finished)

    if (index >= 0) setState("agents", index, "finished", true)
  }

  const actions = [
    { key: "1", label: "Start subagent", run: start },
    { key: "2", label: "Start another", run: start },
    { key: "f", label: "Finish one", run: finish },
    {
      key: "a",
      label: "Finish all",
      run: () => setState("agents", (value) => !value.finished, "finished", true),
    },
    { key: "e", label: "Expand", run: () => setState("open", (value) => !value) },
    {
      key: "m",
      label: "Reverse mid-expand",
      run: () => {
        setState("open", true)
        setTimeout(() => setState("open", false), composerSheetSpring().duration * 400)
      },
    },
    {
      key: "j",
      label: "Scroll up",
      run: () => timeline?.scrollBy({ top: -360, behavior: "smooth" }),
    },
    {
      key: "l",
      label: "Latest",
      run: () => timeline?.scrollTo({ top: timeline.scrollHeight, behavior: "smooth" }),
    },
    { key: "t", label: "Fade", run: () => setState("fade", (value) => !value) },
    {
      key: "v",
      label: "Band / no band",
      run: () => {
        setState("variant", (value) => (value === "band" ? "inline" : "band"))
        setTimeout(() => timeline?.scrollTo({ top: timeline.scrollHeight }), 150)
      },
    },
    {
      key: "0",
      label: "Reset",
      run: () => setState({ agents: [], next: 0, open: false }),
    },
    { key: "k", label: "Knobs", run: () => togglePanel() },
  ]

  const run = (action: (typeof actions)[number]) => {
    setState("action", action.label)
    action.run()
  }

  const togglePanel = () => {
    setState("panel", (value) => !value)

    if (!state.panel) {
      unmountPanel?.()
      unmountPanel = undefined

      return
    }
    void import("@opencode/ui/motion-tuning-panel").then(({ mountMotionPanel }) => {
      if (panel && state.panel) unmountPanel = mountMotionPanel(panel, { title: "Motion", section: "Composer sheet" })
    })
  }

  onMount(() => {
    const keydown = (event: KeyboardEvent) => {
      const target = event.target

      if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA)$/.test(target.tagName)))
        return

      if (event.metaKey || event.ctrlKey || event.altKey) return
      const action = actions.find((item) => item.key === event.key)

      if (!action) return
      event.preventDefault()
      run(action)
    }

    document.addEventListener("keydown", keydown)
    onCleanup(() => document.removeEventListener("keydown", keydown))

    const replay = ["e", "m", "1", "f"].flatMap((key) => {
      const action = actions.find((item) => item.key === key)!

      return [
        motionTuning.action({
          id: `composerSheet.story.${key}`,
          label: action.label,
          group: "Composer sheet",
          run: () => run(action),
        }),
      ]
    })
    onCleanup(() => replay.forEach((remove) => remove()))
    onCleanup(() => unmountPanel?.())

    setTimeout(() => timeline?.scrollTo({ top: timeline.scrollHeight }), 150)
  })

  return (
    <>
      {/* A variant mounts its own sheet; the story's work and open state carry over. */}
      <Show when={state.variant} keyed>
        {(variant) => (
          <SessionPreview
            title="Investigate Alpha and Beta"
            description="opencode · composer sheet"
            document={value()}
            timelineDetail={timelineDetail}
            modelName="Alpha"
            fade={state.fade}
            onTimeline={(element) => (timeline = element)}
            sheet={{
              subagents: subagents(),
              open: state.open,
              onOpenChange: (open) => setState("open", open),
              onOpen: (item) => setState("action", `Open ${item.sessionID}`),
              variant,
            }}
          />
        )}
      </Show>
      <div
        data-slot="composer-sheet-story-controls"
        class="fixed top-2 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-0.5 whitespace-nowrap rounded-lg bg-v2-background-bg-base p-1 text-[12px] shadow-[var(--v2-elevation-floating)]"
      >
        <For each={actions}>
          {(action) => (
            <button
              type="button"
              data-action={action.key}
              class="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-v2-text-text-muted hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base"
              classList={{ "bg-v2-overlay-simple-overlay-hover text-v2-text-text-base": state.action === action.label }}
              onClick={() => run(action)}
            >
              <kbd class="font-mono text-[10px] text-v2-text-text-faint">{action.key}</kbd>
              {action.label}
            </button>
          )}
        </For>
      </div>
      <div ref={panel} class="fixed top-12 right-3 z-[100] max-h-[calc(100vh-6rem)] w-[320px] overflow-auto" />
    </>
  )
}

export default {
  title: "OpenCode/Session/Composer sheet",
  id: "session-composer-sheet",
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "Running subagents as a band on the production Composer's surface. Opening the band sheets its list up over the timeline; the timeline scrolls behind the region with a soft fade. Keys: 1/2 start, f finish one, a finish all, e expand, m collapse mid-expand, j/l scroll, t fade, v band or no band (status in the toolbar), 0 reset, k knobs.",
      },
    },
  },
}

export const Playground = { render: () => <SheetStory fade agents={0} open={false} /> }

export const Running = { render: () => <SheetStory fade agents={2} open={false} /> }

export const Open = { render: () => <SheetStory fade agents={2} open /> }

export const PlaygroundNoBand = { render: () => <SheetStory fade agents={0} open={false} variant="inline" /> }

export const RunningNoBand = { render: () => <SheetStory fade agents={2} open={false} variant="inline" /> }

export const OpenNoBand = { render: () => <SheetStory fade agents={2} open variant="inline" /> }

export const HardEdge = { render: () => <SheetStory fade={false} agents={2} open={false} /> }
