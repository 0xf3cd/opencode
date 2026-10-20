export * as Agent from "./agent.js"

import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Array, Context, Effect, Layer, Types } from "effect"
import { Agent } from "@opencode/schema/agent"
import { Global } from "@opencode/util/global"
import { AgentBuiltins } from "./agent-builtins.js"
import { Bus } from "./bus.js"
import { State } from "./state.js"

export const ID = Agent.ID
export type ID = typeof ID.Type
export const Name = Agent.Name
export type Name = Agent.Name
export const defaultID = ID.make("build")

export const Color = Agent.Color

export const Info = Agent.Info
export type Info = Agent.Info

export { Event } from "@opencode/schema/agent"

export interface Selection {
  readonly id: ID
  readonly info: Info | undefined
}

type Data = {
  agents: Map<ID, Types.DeepMutable<Info>>
  default?: ID
}

export type Editor = {
  list: () => readonly Info[]
  get: (id: ID) => Info | undefined
  default: (id: ID | undefined) => void
  update: (id: ID, fn: (agent: Types.DeepMutable<Info>) => void) => void
  remove: (id: ID) => void
}

export interface Interface extends State.Transformable<Editor> {
  readonly get: (id: ID) => Effect.Effect<Info | undefined>
  readonly resolve: (id?: ID | string) => Effect.Effect<Info | undefined>
  readonly select: (id?: ID | string) => Effect.Effect<Selection>
  readonly list: () => Effect.Effect<Info[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Agent") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const global = yield* Global.Service
    const selectable = (agent: Info | undefined) =>
      agent && agent.mode !== "subagent" && !agent.hidden ? agent : undefined
    const selectedDefault = (data: Data) => {
      const configured = data.default ? selectable(data.agents.get(data.default)) : undefined
      if (configured) return configured
      const build = selectable(data.agents.get(ID.make("build")))
      if (build) return build
      for (const agent of data.agents.values()) {
        const fallback = selectable(agent)
        if (fallback) return fallback
      }
    }
    const list = (data: Data) => {
      const agents = Array.fromIterable(data.agents.values())
      const selected = selectedDefault(data)
      if (!selected) return agents
      return [selected, ...agents.filter((agent) => agent.id !== selected.id)]
    }
    const edit = (editor: Data): Editor => ({
      list: () => Array.fromIterable(editor.agents.values()) as Info[],
      get: (id) => editor.agents.get(id),
      default: (id) => {
        editor.default = id
      },
      update: (id, fn) => {
        const current = editor.agents.get(id) ?? (Info.default(id) as Types.DeepMutable<Info>)
        if (!editor.agents.has(id)) editor.agents.set(id, current)
        fn(current)
        current.id = id
      },
      remove: (id) => {
        editor.agents.delete(id)
      },
    })
    const state = State.create<Data, Editor>({
      name: "agent",
      // Built-ins exist before plugins activate, so a booting Location never lists no agents.
      initial: () => {
        const data: Data = { agents: new Map() }
        AgentBuiltins.seed(edit(data), global)
        return data
      },
      editor: edit,
      notify: State.changes(list, () => bus.publish(Agent.Event.Updated, {}).pipe(Effect.asVoid)),
    })

    return Service.of({
      transform: state.transform,
      reload: state.reload,
      get: Effect.fn("Agent.get")(function* (id) {
        return state.get().agents.get(id)
      }),
      resolve: Effect.fnUntraced(function* (id) {
        if (id !== undefined) return state.get().agents.get(ID.make(id))
        return selectedDefault(state.get())
      }),
      select: Effect.fn("Agent.select")(function* (id) {
        if (id !== undefined) {
          const selected = ID.make(id)
          return { id: selected, info: state.get().agents.get(selected) }
        }
        const info = selectedDefault(state.get())
        return { id: info?.id ?? defaultID, info }
      }),
      list: Effect.fn("Agent.list")(function* () {
        return list(state.get())
      }),
    })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [Bus.node, Global.node] })
