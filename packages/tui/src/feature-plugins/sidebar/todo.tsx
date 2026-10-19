import { TodoRpc } from "@opencode/core/tool/plugin/todo-rpc"
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show } from "solid-js"
import { TodoItem } from "../../component/todo-item"

export function SidebarTodo(props: { context: Plugin.Context; sessionID: string }) {
  const [view, updateView] = props.context.storage.store("view", { initial: { open: true } })
  const theme = props.context.theme
  const rpc = props.context.client.rpc(TodoRpc.Definition)
  const directory = createMemo(() => props.context.data.session.get(props.sessionID)?.location.directory)
  const revert = createMemo(() => props.context.data.session.get(props.sessionID)?.revert?.messageID)
  const [state, setState] = createSignal<{ sessionID: string; todos: ReadonlyArray<TodoRpc.Todo> }>()
  const list = createMemo(() => (state()?.sessionID === props.sessionID ? (state()?.todos ?? []) : []))
  // Bumped by every request and update so a slower `get` cannot overwrite newer state.
  let version = 0

  onCleanup(
    rpc.events.on("updated", (event) => {
      if (event.data.sessionID !== props.sessionID) return
      version++
      setState({ sessionID: event.data.sessionID, todos: event.data.todos })
    }),
  )

  createEffect(
    on([() => props.sessionID, directory, revert], ([sessionID, path]) => {
      if (!path) return
      const requested = ++version
      rpc
        .get({ sessionID }, { location: { directory: path } })
        .then((result) => {
          if (requested !== version) return
          setState({ sessionID, todos: result.enabled ? result.todos : [] })
        })
        .catch((error) => {
          if (requested !== version) return
          console.error("Failed to load todos", error)
          setState({ sessionID, todos: [] })
        })
    }),
  )
  const remaining = createMemo(
    () => list().filter((item) => item.status === "pending" || item.status === "in_progress").length,
  )

  return (
    <Show when={list().length > 0}>
      <box>
        <box
          flexDirection="row"
          gap={1}
          onMouseDown={() => {
            if (list().length <= 2) return
            void updateView((draft) => {
              draft.open = !draft.open
            }).catch((error) => console.error("Failed to persist todo sidebar state", error))
          }}
        >
          <Show when={list().length > 2}>
            <text fg={theme.text.base}>{view.open ? "▼" : "▶"}</text>
          </Show>
          <text fg={theme.text.base}>
            <b>Todo</b>
            <Show when={list().length > 2 && !view.open}>
              <span style={{ fg: theme.text.muted }}> ({remaining()} remaining)</span>
            </Show>
          </text>
        </box>
        <Show when={list().length <= 2 || view.open}>
          <For each={list()}>{(item) => <TodoItem theme={theme} todo={item} />}</For>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode.sidebar.todo",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (props) => <SidebarTodo context={context} sessionID={props.sessionID} />,
    })
  },
})
