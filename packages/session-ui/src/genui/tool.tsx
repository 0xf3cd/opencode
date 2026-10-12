import { createMemo, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Option, Schema } from "effect"
import { GenUI } from "@opencode/plugin-genui/genui"
import { useI18n } from "@opencode/ui/context/i18n"
import { Icon } from "@opencode/ui/icon"
import { TextShimmer } from "@opencode/ui/text-shimmer"
import { useData } from "../context/data"
import { ToolRegistry, type ToolProps } from "../tools/tool-renderer"
import { genuiReplyText, GenUISurface, type GenUIReply } from "./surface"

const decodeInput = Schema.decodeUnknownOption(GenUI.RenderInput)

/** A `genui_render` call in the timeline: the surface itself, drawn while its program streams in. */
function GenUITool(props: ToolProps) {
  const i18n = useI18n()
  const data = useData()
  const input = createMemo(() => Option.getOrElse(decodeInput(props.input), (): GenUI.RenderInput => ({})))
  const writing = () => props.status === "streaming" || props.status === "running" || props.status === "pending"
  const [state, setState] = createStore({ sending: false })

  const reply = (value: GenUIReply) => {
    const prompt = data.prompt
    const sessionID = data.sessionID

    if (!prompt || !sessionID || state.sending) return
    setState("sending", true)
    const heading = i18n.t("ui.genui.submitted", { title: input().title ?? i18n.t("ui.genui.title") })
    void prompt({ sessionID, text: genuiReplyText(value, heading) }).finally(() => setState("sending", false))
  }

  return (
    <div data-component="genui-inline" data-writing={writing() || undefined}>
      <div data-slot="genui-inline-header">
        <span data-slot="genui-row-icon">
          <Icon name="window-analytics" size="small" />
        </span>
        <span data-slot="genui-inline-title">{input().title ?? i18n.t("ui.genui.title")}</span>
        <Show when={writing()}>
          <span data-slot="genui-inline-status">
            <TextShimmer text={i18n.t("ui.genui.writing")} active />
          </span>
        </Show>
      </div>
      <Show when={input().code}>
        {(code) => (
          <div data-slot="genui-inline-body">
            <GenUISurface
              code={code()}
              streaming={writing()}
              busy={!data.prompt || state.sending}
              onReply={reply}
              onOpen={(url) => {
                if (/^https?:\/\//iu.test(url)) window.open(url, "_blank", "noopener,noreferrer")
              }}
            />
          </div>
        )}
      </Show>
    </div>
  )
}

ToolRegistry.register({ name: GenUI.RENDER_TOOL, render: GenUITool })
