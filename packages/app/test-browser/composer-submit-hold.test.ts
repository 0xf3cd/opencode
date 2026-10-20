import { expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import type { ModelSelection } from "@/providers/models/selection"
import type { ActiveComposerAdapter, ComposerControls, ComposerSession } from "@/composer/adapter"
import { createMemoryComposerState } from "@/composer/state"
import { createComposerSubmit } from "@/composer/submit"

// SAFETY: submission reads only the selected model's id and provider id.
const model = { id: "model-1", provider: { id: "provider-1" } } as NonNullable<ReturnType<ModelSelection["current"]>>

const selection = {
  ready: Object.assign(() => true, { promise: undefined }),
  key: () => ({ providerID: "provider-1", modelID: "model-1" }),
  current: () => model,
  recent: () => [model],
  favorite: { list: () => [], toggle() {} },
  list: () => [model],
  cycle() {},
  set() {},
  visible: () => true,
  setVisibility() {},
  variant: {
    configured: () => undefined,
    selected: () => undefined,
    current: () => undefined,
    list: () => [],
    set() {},
    cycle() {},
  },
} satisfies ModelSelection

const session: ComposerSession = {
  id: "session-1",
  directory: "/repo",
  handoff: { set() {}, clear() {} },
  current: () => ({ agent: "build", model: { id: "model-1", providerID: "provider-1" } }),
  admitted: () => true,
  api: {
    command: async () => undefined,
    shell: async () => undefined,
    switchAgent: async () => undefined,
    switchModel: async () => undefined,
    revert: { commit: async () => undefined },
  },
  data: {
    location: { command: { list: () => [] } },
    session: {
      prompt: async (value) => ({
        id: value.id ?? "msg_admitted",
        sessionID: value.sessionID,
        time: { created: 0 },
        type: "user" as const,
        payload: { text: value.text },
        delivery: value.delivery ?? "steer",
      }),
      setStatus() {},
    },
  },
}

test.each([
  { name: "sends a prompt held while the agents load once they do", agent: "build", toasts: 0, left: "" },
  { name: "asks for an agent only once loading finds none", agent: "", toasts: 1, left: "ship it" },
])("composer-submit-hold: $name", async (row) => {
  const [agent, setAgent] = createSignal<string>()
  const state = createMemoryComposerState({ prompt: "ship it" }).capture()
  const toasts: string[] = []

  const controls = (): ComposerControls => ({
    agents: { available: [], options: [], current: agent() ?? "", visible: true, select() {} },
    model: { selection, paid: true, loading: agent() === undefined },
  })

  const adapter: ActiveComposerAdapter = {
    kind: "active-session",
    state,
    ready: () => true,
    controls,
    working: () => false,
    session: () => session,
    interrupt: async () => undefined,
    submitted() {},
    setEditor() {},
  }

  const { submission, dispose } = createRoot((dispose) => ({
    dispose,
    submission: createComposerSubmit({
      adapter,
      mode: () => "normal",
      commands: () => [],
      editor: () => undefined,
      queueScroll() {},
      addToHistory() {},
      removeFromHistory() {},
      resetHistory() {},
      setMode() {},
      closePopover() {},
      notify: { missingSelection: () => void toasts.push("missing"), unqueueable() {}, failed() {} },
      comments: { capture: () => [], clear() {}, restore() {} },
    }),
  }))

  try {
    const held = submission.submit(new Event("submit"))
    // A second press while held neither sends twice nor asks for an agent.
    await submission.submit(new Event("submit"))

    expect(submission.held()).toBe(true)
    expect(toasts).toEqual([])
    expect(text(state)).toBe("ship it")

    setAgent(row.agent)
    await held

    expect(submission.held()).toBe(false)
    expect(toasts).toHaveLength(row.toasts)
    expect(text(state)).toBe(row.left)
  } finally {
    dispose()
  }
})

function text(state: ReturnType<ReturnType<typeof createMemoryComposerState>["capture"]>) {
  return state
    .current()
    .map((part) => ("content" in part ? part.content : ""))
    .join("")
}
