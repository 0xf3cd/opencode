import { createEffect, onCleanup, onMount, Show } from "solid-js"
import { Orb, orbsAvailable, type AgentOrbState } from "../../agent-orb/orb"
import { margin } from "../../agent-orb/render"
import "./agent-orb.css"

export type { AgentOrbState }

// The iOS app's agent-status glyph: a 7 × 7 LED dot sphere whose band poses morph from one state into the next.
// `size` is read once at mount. Without WebGL2 it shows a static dotted disc tinted by state.
export function AgentOrb(props: { state: AgentOrbState; size?: number; class?: string }) {
  const size = props.size ?? 16
  const live = orbsAvailable()
  let host!: HTMLSpanElement
  let orbLayer!: HTMLCanvasElement
  let shellLayer!: HTMLCanvasElement

  onMount(() => {
    if (!live) return
    const orb = new Orb(host, { orb: orbLayer, shell: shellLayer }, size, props.state)

    createEffect(() => orb.set(props.state))
    onCleanup(() => orb.dispose())
  })

  return (
    <span
      ref={host}
      class={props.class}
      data-component="agent-orb"
      data-state={props.state}
      data-live={live ? "" : undefined}
      style={{ "--agent-orb-size": `${size}px`, "--agent-orb-margin": `${margin(size)}px` }}
      aria-hidden="true"
    >
      <Show when={live}>
        <canvas ref={orbLayer} data-slot="agent-orb-layer" data-shown={props.state !== "shell"} />
        <canvas ref={shellLayer} data-slot="agent-orb-layer" data-shown={props.state === "shell"} />
      </Show>
    </span>
  )
}
