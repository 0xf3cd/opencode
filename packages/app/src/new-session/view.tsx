import { useDialog } from "@opencode/ui/context/dialog"
import { Tooltip } from "@opencode/ui/tooltip"
import { Icon } from "@opencode/ui/icon"
import { Show, createMemo, createSignal } from "solid-js"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { getFilename } from "@opencode/util/path"
import {
  displayName,
  getProjectAvatarSource,
  getProjectAvatarVariant,
  ProjectAvatar,
} from "@opencode/ui/project-avatar"
import { Schema } from "effect"
import createPresence from "solid-presence"
import { Composer } from "@/composer/composer"
import { ComposerDropzone } from "@/composer/dropzone"
import type { ComposerModel } from "@/composer/model"
import {
  PromptProjectAddButton,
  type PromptProject,
  type PromptProjectController,
} from "@/new-session/project/selector"
import type { useNewSessionLocationDialog } from "@/new-session/location/dialog"
import { useLanguage } from "@/runtime/i18n/language"
import { useWorkspaceLocation } from "@/workspaces/location"
import { useProviders } from "@/providers/catalog/providers"
import { NEW_SESSION_CONTENT_WIDTH } from "@/new-session/layout"
import { Persist, persisted } from "@/runtime/persistence/storage"
import { Persistence } from "@/runtime/persistence/schema"
import { useSettings } from "@/settings/model"
import type { NewSessionWorkspaceController } from "./workspace/controller"
import { NewSessionPinBoard } from "./pin-board"
import { NewSessionWordmark } from "./wordmark"

const providerTipDismissalDuration = 30 * 24 * 60 * 60 * 1000

export const WorkspaceOnboardingSchema = Persistence.struct({
  used: Schema.Boolean,
})

export const ProviderTipSchema = Persistence.struct({
  dismissedAt: Schema.Finite,
})

export const WorkspaceTipSchema = ProviderTipSchema

export function NewSessionView(props: {
  composer: ComposerModel
  project: PromptProjectController
  workspace: NewSessionWorkspaceController
  location: ReturnType<typeof useNewSessionLocationDialog>
}) {
  const [onboarding, setOnboarding, , onboardingReady] = persisted(
    Persist.global("workspace-onboarding"),
    WorkspaceOnboardingSchema,
    { used: false },
  )

  const settings = useSettings()
  const [wordmark, setWordmark] = createSignal<HTMLDivElement>()

  const select = (value: string) => {
    props.workspace.selection.set(value)

    if (value !== "main") setOnboarding("used", true)
  }

  return (
    <div class="@container relative flex flex-col min-h-0 h-full flex-1">
      <div
        data-component="new-session"
        class="relative isolate flex-1 min-h-0 overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]"
      >
        <ComposerDropzone
          active={props.composer.state.drag === "active"}
          input={props.composer.model.selection.current()?.capabilities.input}
        />
        <div class="absolute inset-x-0 top-[25.375%] flex justify-center px-6">
          <div class={NEW_SESSION_CONTENT_WIDTH}>
            <NewSessionWordmark ref={setWordmark} />
            <div class="mt-8 flex flex-col gap-3">
              <div data-slot="new-session-composer" data-composer-group={props.project.selected() ? "" : undefined}>
                <Composer model={props.composer} />
                <Show when={props.project.selected()}>
                  {(project) => (
                    <NewSessionLocation
                      project={project()}
                      workspace={props.workspace.bar.visible() ? props.workspace.selection.value() : "main"}
                      root={props.workspace.project.root()}
                      onboarding={onboardingReady() && !onboarding.used && props.workspace.bar.visible()}
                      onClick={() =>
                        props.location({
                          onWorkspace: (value) => {
                            if (value !== "main") setOnboarding("used", true)
                          },
                        })
                      }
                    />
                  )}
                </Show>
              </div>
              <Show when={props.project.empty()}>
                <PromptProjectAddButton controller={props.project} />
              </Show>
            </div>
          </div>
        </div>
        <Show when={wordmark()}>
          {(logo) => <NewSessionPinBoard logo={logo()} sound={settings.sounds.interfaceEnabled} />}
        </Show>
        <NewSessionTips
          selection={props.composer.model.selection}
          onDone={props.composer.restoreFocus}
          workspaceEligible={
            !!props.project.selected() &&
            props.workspace.bar.visible() &&
            props.workspace.selection.value() !== "create" &&
            props.workspace.project.managed() === 0
          }
          onWorkspace={() => select("create")}
        />
      </div>
    </div>
  )
}

function NewSessionTips(props: {
  selection: ComposerModel["model"]["selection"]
  onDone: () => void
  workspaceEligible: boolean
  onWorkspace: () => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const sdk = useWorkspaceLocation()
  const providers = useProviders(() => sdk().directory)

  const [providerState, setProviderState, , providerReady] = persisted(
    Persist.global("new-session.provider-tip"),
    ProviderTipSchema,
    { dismissedAt: 0 },
  )

  const [workspaceState, setWorkspaceState, , workspaceReady] = persisted(
    Persist.global("new-session.workspace-tip"),
    WorkspaceTipSchema,
    { dismissedAt: 0 },
  )

  const workspaceVisible = createMemo(
    () =>
      props.workspaceEligible &&
      workspaceReady() &&
      Date.now() - workspaceState.dismissedAt >= providerTipDismissalDuration,
  )

  const providerVisible = createMemo(
    () =>
      providerReady() &&
      providers.anyConnection() === false &&
      Date.now() - providerState.dismissedAt >= providerTipDismissalDuration,
  )

  const tip = createMemo<"workspace" | "provider" | undefined>(() => {
    if (providerVisible()) return "provider"

    if (workspaceVisible()) return "workspace"
  })

  const displayed = createMemo<"workspace" | "provider" | undefined>((previous) => tip() ?? previous)
  const [ref, setRef] = createSignal<HTMLDivElement>()

  const presence = createPresence({
    show: () => tip() !== undefined,
    element: () => ref() ?? null,
  })

  const open = () => {
    const current = tip()

    if (!current) return

    if (current === "workspace") {
      setWorkspaceState("dismissedAt", Date.now())
      props.onWorkspace()

      return
    }

    void import("@/providers/connect/dialog").then(({ DialogConnectProvider }) => {
      void dialog.show(() => (
        <DialogConnectProvider directory={sdk().directory} selection={props.selection} onDone={props.onDone} />
      ))
    })
  }

  const dismiss = () => {
    const current = tip()

    if (!current) return

    if (current === "workspace") {
      setWorkspaceState("dismissedAt", Date.now())

      return
    }

    setProviderState("dismissedAt", Date.now())
  }

  return (
    <Show when={presence.present()}>
      <div class="pointer-events-none absolute inset-x-0 bottom-4 flex justify-center px-10">
        <div
          ref={setRef}
          data-component="new-session-tip"
          data-visible={tip() !== undefined}
          class="group/new-session-tip pointer-events-auto relative flex h-6 max-w-full items-center transition-[opacity,transform] duration-[250ms] ease-[cubic-bezier(0.215,0.61,0.355,1)] motion-reduce:transition-none"
          classList={{ "data-[visible=false]:animate-out fade-out slide-out-to-bottom-4": true }}
        >
          <button
            type="button"
            class="flex h-6 min-w-0 items-center rounded-[4px] pl-1.5 text-[13px] leading-text-compact tracking-[-0.04px] text-v2-text-text-faint transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-muted focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-muted focus-visible:outline-none"
            onClick={open}
          >
            <span class="truncate">
              {language.t(displayed() === "workspace" ? "home.workspaceTip" : "home.providerTip")}
            </span>
            <span class="flex size-6 shrink-0 items-center justify-center" aria-hidden="true">
              <Icon name="chevron-down" size="small" class="-rotate-90" />
            </span>
          </button>
          <Tooltip
            class="hover-reveal absolute left-full top-0 flex h-6 w-7 items-center justify-end delay-0 duration-0 group-hover/new-session-tip:delay-[250ms] group-hover/new-session-tip:duration-150 group-hover/new-session-tip:opacity-100 focus-within:delay-0 focus-within:duration-0 focus-within:opacity-100"
            placement="top"
            openDelay={1000}
            value={language.t("common.dismiss")}
          >
            <button
              type="button"
              class="flex size-6 items-center justify-center rounded-[4px] text-v2-icon-icon-muted transition-[background-color,color] duration-150 ease-in-out hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-icon-icon-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-icon-icon-base focus-visible:outline-none"
              aria-label={language.t("common.dismiss")}
              onClick={dismiss}
            >
              <Icon name="xmark-small" />
            </button>
          </Tooltip>
        </div>
      </div>
    </Show>
  )
}

/** The band under the Composer: the location picker on the `+` column and the session's directory on the send column. */
function NewSessionLocation(props: {
  project: PromptProject
  /** "main", "create", or a worktree directory. */
  workspace: string
  root: string
  onboarding: boolean
  onClick: () => void
}) {
  const language = useLanguage()
  const [truncated, setTruncated] = createSignal(false)

  const worktree = () => {
    if (props.workspace === "main") return

    if (props.workspace === "create") return language.t("workspace.new")

    return getFilename(props.workspace)
  }

  const path = () => {
    if (props.workspace === "create") return

    return props.workspace === "main" ? props.root : props.workspace
  }

  return (
    <div
      data-composer-band
      class="flex h-9 min-w-0 items-center gap-3 px-2 text-[13px] font-[440] leading-[var(--line-height-compact)] tracking-[-0.04px]"
    >
      <div class="flex min-w-0 max-w-[60%] shrink-0 @max-[560px]:max-w-full">
        <Tooltip
          appearance={props.onboarding ? "large" : undefined}
          placement="top"
          openDelay={800}
          value={
            props.onboarding ? (
              <div class="flex flex-col gap-1 text-start">
                <div class="flex items-center gap-1.5 font-[530] text-v2-text-text-base">
                  <Icon name="outline-worktree" size="small" class="shrink-0 text-v2-text-text-accent" />
                  <span>{language.t("workspace.onboarding.title")}</span>
                </div>
                <span class="font-[440] text-v2-text-text-muted">{language.t("workspace.onboarding.description")}</span>
              </div>
            ) : (
              language.t("session.new.workspace.trigger.tooltip")
            )
          }
          contentClass={props.onboarding ? "max-w-[280px]" : undefined}
          class="flex min-w-0 max-w-full"
        >
          <button
            type="button"
            data-action="prompt-project"
            aria-haspopup="dialog"
            aria-description={language.t("session.new.workspace.trigger.tooltip")}
            class="flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md text-start ps-1.5 pe-2 text-v2-text-text-muted transition-colors hover:bg-v2-overlay-simple-overlay-hover hover:text-v2-text-text-base focus-visible:bg-v2-overlay-simple-overlay-hover focus-visible:text-v2-text-text-base focus-visible:outline-none"
            onClick={props.onClick}
          >
            <ProjectAvatar
              class="shrink-0"
              fallback={displayName(props.project)}
              src={getProjectAvatarSource(props.project.id, props.project.icon)}
              variant={getProjectAvatarVariant(props.project.icon?.color)}
            />
            <span class="min-w-0 truncate">{displayName(props.project)}</span>
            <Show when={worktree()}>
              {(name) => (
                <>
                  <Icon name="chevron-right" class="-mx-1 shrink-0 text-v2-icon-icon-faint" />
                  <span class="min-w-12 shrink-[1000] truncate">{name()}</span>
                </>
              )}
            </Show>
            <Show when={props.onboarding}>
              <span
                data-slot="workspace-onboarding-dot"
                aria-hidden="true"
                class="size-1.5 shrink-0 rounded-full bg-v2-text-text-accent"
              />
            </Show>
          </button>
        </Tooltip>
      </div>
      <Show when={path()}>
        {(directory) => (
          <div class="flex min-w-0 flex-1 justify-end @max-[560px]:hidden">
            <Tooltip
              placement="top"
              value={directory()}
              disabled={!truncated()}
              class="flex min-w-0"
              contentClass="max-w-[calc(100vw-32px)] break-all"
            >
              <span
                ref={(element) =>
                  createResizeObserver(element, () => setTruncated(element.scrollWidth > element.clientWidth))
                }
                data-slot="new-session-location-path"
                class="block min-w-0 truncate text-v2-text-text-faint [direction:rtl] [text-align:end]"
              >
                <bdi dir="ltr">{directory()}</bdi>
              </span>
            </Tooltip>
          </div>
        )}
      </Show>
    </div>
  )
}
