import { createMemo, onMount, Show, type JSX } from "solid-js"
import { SessionPermissionDock } from "@/session/requests/session-permission-dock"
import { SessionQuestionDock } from "@/session/requests/session-question-dock"
import { SessionWebSearchDock } from "@/session/requests/session-websearch-dock"
import type { SessionComposerRegionController } from "./session-composer-region-controller"
import { SpringHeight } from "./spring-height"

type SessionComposerRegionState = Pick<
  SessionComposerRegionController["state"],
  "questionRequest" | "websearch" | "permissionRequest" | "permissionResponding" | "decide" | "blocked"
>

export type SessionComposerRegionViewController = Pick<
  SessionComposerRegionController,
  "centered" | "onResponseSubmit" | "setDockRef" | "child" | "showComposer"
> & { state: SessionComposerRegionState }

export function SessionComposerRegion(props: {
  controller: SessionComposerRegionViewController
  composer: JSX.Element
  subagent: JSX.Element
}) {
  const controller = props.controller
  // The region springs between the docks and the composer as they come and go; what arrives fades in over the card.
  const docks = createMemo(() =>
    [
      controller.state.websearch.request()?.id,
      controller.state.questionRequest()?.id,
      controller.state.permissionRequest()?.id,
      controller.state.blocked(),
    ].join(),
  )
  let mounted = false
  const arrive = () => (mounted ? "animate-in fade-in" : undefined)
  onMount(() => (mounted = true))

  return (
    <div
      ref={controller.setDockRef}
      data-component="session-composer-dock"
      class="w-full shrink-0 flex flex-col justify-center items-center pb-3 pointer-events-none"
    >
      {/* Only the docks and composer take the pointer; the gaps beside them belong to the timeline underneath. */}
      <div
        classList={{
          "w-full px-3 *:pointer-events-auto": true,
          "md:max-w-session md:mx-auto": controller.centered(),
        }}
      >
        <SpringHeight
          watch={docks()}
          bottom
          class="data-[moving]:rounded-xl data-[moving]:bg-v2-background-bg-base data-[moving]:shadow-[var(--v2-elevation-raised)]"
        >
          <Show when={controller.state.websearch.request()}>
            <div class={arrive()}>
              <SessionWebSearchDock model={controller.state.websearch} onSubmit={controller.onResponseSubmit} />
            </div>
          </Show>
          <Show when={controller.state.questionRequest()} keyed>
            {(request) => (
              <div class={arrive()}>
                <SessionQuestionDock request={request} onSubmit={controller.onResponseSubmit} />
              </div>
            )}
          </Show>

          <Show when={controller.state.permissionRequest()} keyed>
            {(request) => (
              <div class={arrive()}>
                <SessionPermissionDock
                  request={request}
                  responding={controller.state.permissionResponding()}
                  onDecide={(response) => {
                    controller.onResponseSubmit()
                    controller.state.decide(response)
                  }}
                />
              </div>
            )}
          </Show>

          <Show when={controller.showComposer()}>
            <div class={`relative z-[70] ${arrive() ?? ""}`}>
              <Show
                when={controller.child()}
                fallback={<Show when={!controller.state.blocked()}>{props.composer}</Show>}
              >
                {props.subagent}
              </Show>
            </div>
          </Show>
        </SpringHeight>
      </div>
    </div>
  )
}
