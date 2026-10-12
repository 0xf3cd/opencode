import { createMemo, createSignal, Show } from "solid-js"
import { GenUISurface, type GenUIReply } from "@opencode/session-ui/genui"
import { ScrollView } from "@opencode/ui/scroll-view"
import type { MountedSession } from "../sdk"
import type { GenUIModel } from "./model"

export default function GenUIPanel(props: { model: GenUIModel; session: MountedSession; id: string }) {
  const surface = createMemo(() => props.model.surfaces(props.session).find((item) => item.id === props.id))
  const [sending, setSending] = createSignal(false)

  const reply = (value: GenUIReply) => {
    if (sending()) return
    setSending(true)
    void props.model.reply(props.session, surface()?.title ?? "", value).finally(() => setSending(false))
  }

  return (
    <div class="flex h-full min-h-0 flex-col bg-v2-background-bg-base" data-slot="genui-panel">
      <ScrollView class="min-h-0 flex-1">
        <Show when={surface()?.code}>
          {(code) => (
            <GenUISurface
              code={code()}
              busy={sending()}
              onReply={reply}
              onOpen={(url) => props.model.open(props.session, url)}
            />
          )}
        </Show>
      </ScrollView>
    </div>
  )
}
