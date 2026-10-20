import { Show, createMemo } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Button } from "@opencode/ui/button"
import { useDialog } from "@opencode/ui/context/dialog"
import { Icon } from "@opencode/ui/icon"
import { Keybind } from "@opencode/ui/keybind"
import { consoleModelGroup } from "@/providers/models/provider-group"
import { consoleProviderName } from "@/providers/catalog/console"
import { Tooltip } from "@opencode/ui/tooltip"
import { ComposerEditor, composerJoinedLayouts, type ComposerLayout } from "./editor/editor"
import { DialogSelectModel, ModelSelectorDrawer } from "@/providers/models/select-dialog"
import { ModelDetails } from "@/providers/models/details"
import { DialogSelectModelUnpaid } from "@/providers/models/unpaid"
import { formatKeybind, useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import type { ComposerModel } from "./model"

export function Composer(props: {
  class?: string
  model: ComposerModel
  borderUnderlay?: boolean
  readOnly?: boolean
  suggestionBoundary?: () => HTMLElement | undefined
  layout?: ComposerLayout
}) {
  const dialog = useDialog()
  const command = useCommand()
  const language = useLanguage()

  const modelName = () => {
    const selection = props.model.model.selection
    const model = selection.current()

    if (model) return model.name
    const key = selection.key()

    if (key) return language.t("dialog.model.unavailable", { model: key.modelID })

    return language.t("dialog.model.select.title")
  }

  // Joined layouts show the variant inside the model chip; the model dialog changes it with ←/→.
  const variantName = () => {
    if (!composerJoinedLayouts.includes(props.layout ?? "today")) return
    const control = props.model.view.variant

    if (!control || control.options().length < 2 || control.current() === "default") return

    return control.options().find((option) => option.id === control.current())?.label ?? control.current()
  }

  return (
    <div class="flex flex-col gap-3">
      <ComposerEditor
        controller={props.model}
        borderUnderlay={props.borderUnderlay}
        readOnly={props.readOnly}
        class={props.class}
        modelControlsVisible={!props.model.model.loading}
        attachKeybind={command.keybindParts("file.attach")}
        attachShortcut={command.keybind("file.attach")}
        alternateKeybind={[formatKeybind("mod", language.t), "↵"]}
        exitShellKeybind={[formatKeybind("esc", language.t)]}
        suggestionBoundary={props.suggestionBoundary}
        layout={props.layout}
        modelControl={
          <ComposerModelControl
            loading={props.model.model.loading}
            paid={props.model.model.paid}
            title={language.t("command.model.choose")}
            keybind={command.keybindParts("model.choose")}
            model={props.model.model.selection}
            providerName={props.model.model.providerName}
            modelName={modelName()}
            variantName={variantName()}
            onClose={props.model.restoreFocus}
            onUnpaidClick={() => dialog.show(() => <DialogSelectModelUnpaid model={props.model.model.selection} />)}
          />
        }
      />
    </div>
  )
}

function ComposerModelControl(props: {
  loading: boolean
  paid: boolean
  title: string
  keybind: string[]
  model: ComposerModel["model"]["selection"]
  providerName?: string
  modelName: string
  variantName?: string
  onClose: () => void
  onUnpaidClick: () => void
}) {
  const shouldAnimate = createMemo<boolean>((previous) => previous ?? props.loading)
  const mobile = createMediaQuery("(max-width: 767px)")
  const dialog = useDialog()
  const managed = createMemo(() => consoleModelGroup(props.model.list()))

  const providerName = (provider: { id: string; name: string }) => {
    const group = managed()

    return group?.providers.some((item) => item.id === provider.id)
      ? consoleProviderName(group, provider.name)
      : provider.name
  }

  const content = () => (
    <>
      <span class="flex min-w-0 whitespace-nowrap leading-4">
        <Show when={props.providerName}>
          {(name) => (
            <span data-slot="composer-model-provider" class="contents">
              <span class="shrink-0 text-v2-text-text-faint">{name()}</span>
              <span class="shrink-0 whitespace-pre text-v2-text-text-faint">{" / "}</span>
            </span>
          )}
        </Show>
        <span class="truncate">{props.modelName}</span>
        <Show when={props.variantName}>
          {(variant) => <span class="shrink-0 ps-1.5 capitalize text-v2-text-text-faint">{variant()}</span>}
        </Show>
      </span>
      <span class="-ml-0.5 -mr-1 flex shrink-0">
        <Icon name="chevron-down" />
      </span>
    </>
  )

  return (
    <Show when={!props.loading}>
      <Tooltip
        inactive={mobile()}
        contentClass={props.model.current() ? "!p-0 rounded-md" : undefined}
        placement="top"
        gutter={4}
        value={
          <Show
            when={props.model.current()}
            fallback={
              <>
                {props.title}
                <Keybind keys={props.keybind} variant="neutral" />
              </>
            }
          >
            {(model) => (
              <div class="flex w-[188px] max-w-[calc(100vw-24px)] flex-col">
                <ModelDetails model={model()} provider={providerName(model().provider)} />
                <div class="flex h-7 min-w-0 items-center gap-2 border-t-[0.5px] border-v2-border-border-base px-2">
                  <span class="min-w-0 flex-1 truncate text-v2-text-text-faint">{props.title}</span>
                  <Keybind keys={props.keybind} variant="neutral" />
                </div>
              </div>
            )}
          </Show>
        }
      >
        <Show
          when={mobile()}
          fallback={
            <Button
              data-action="composer-model"
              data-control-type="dialog"
              variant="ghost-muted"
              size="normal"
              class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440]"
              classList={{ "animate-in fade-in": shouldAnimate() }}
              style={{ height: "28px" }}
              onMouseDown={(event: MouseEvent) => event.preventDefault()}
              onClick={(event: MouseEvent) => {
                if (!props.paid) return props.onUnpaidClick()
                // A pointer open keeps focus in the composer, so the dialog returns it to the caret. A keyboard open
                // (a click with no pointer presses) returns focus to this trigger instead of moving it to the editor.
                void dialog.show(
                  () => <DialogSelectModel model={props.model} />,
                  event.detail === 0 ? undefined : props.onClose,
                )
              }}
            >
              {content()}
            </Button>
          }
        >
          <ModelSelectorDrawer
            model={props.model}
            trigger={(triggerProps) => (
              <Button
                {...triggerProps}
                variant="ghost-muted"
                size="normal"
                style={{ height: "28px" }}
                class="min-w-0 max-w-[60cqw] justify-start ![font-weight:440]"
                classList={{ "animate-in fade-in": shouldAnimate() }}
                data-action="composer-model"
                data-control-type="drawer"
              >
                {content()}
              </Button>
            )}
            onClose={props.onClose}
          />
        </Show>
      </Tooltip>
    </Show>
  )
}
