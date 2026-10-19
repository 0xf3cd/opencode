import { Show } from "solid-js"
import { createMediaQuery } from "@solid-primitives/media"
import { Icon } from "@opencode/ui/icon"
import { IconButton } from "@opencode/ui/icon-button"
import { Keybind } from "@opencode/ui/keybind"
import { Tooltip } from "@opencode/ui/tooltip"
import { useCommand } from "@/shell/commands/command"
import { useLanguage } from "@/runtime/i18n/language"
import { usePlatform } from "@/runtime/platform/platform"
import { useSettings } from "@/settings/model"
import { betaSettingsAvailable } from "@/settings/experimental/beta"

// Native controls: 14px left inset, two 20px button pitches, and a 14px button.
export const macTrafficLightsBaseWidth = 68

// The horizontal titlebar starts its first control 16px past the traffic lights. Newer macOS draws wider traffic
// lights than the 68px base, so this gap also keeps the collapsed toggle clear of them.
const macTrafficLightsGap = 16

// The toggle's 28px plus a 4px gap before the header contents.
const slotWidth = 32

// The shell's 8px inline inset plus the session header's 10px start padding.
const contentStart = 18

// Hiding the vertical tabs sidebar is a beta setting, off by default. Without it the sidebar always stays open.
export function useSidebar() {
  const settings = useSettings()
  const toggleable = () => betaSettingsAvailable && settings.appearance.sidebarToggle()
  const open = () => !toggleable() || settings.appearance.sidebarOpen()

  return {
    toggleable,
    open,
    toggle: () => settings.appearance.setSidebarOpen(!open()),
  }
}

export function SidebarToggle() {
  const command = useCommand()
  const language = useLanguage()
  const sidebar = useSidebar()
  const keybind = () => command.keybindParts("sidebar.toggle")

  return (
    <Tooltip
      class="shrink-0 [app-region:no-drag]"
      placement="bottom"
      value={
        <>
          {language.t("command.sidebar.toggle")}
          <Show when={keybind().length > 0}>
            <Keybind keys={keybind()} variant="neutral" />
          </Show>
        </>
      }
    >
      <IconButton
        type="button"
        variant="ghost-muted"
        size="large"
        class="shrink-0"
        state={sidebar.open() ? "pressed" : undefined}
        onClick={sidebar.toggle}
        aria-label={language.t("command.sidebar.toggle")}
        aria-expanded={sidebar.open()}
        aria-controls="vertical-tabs-sidebar"
        icon={<Icon name="layout-left" />}
      />
    </Tooltip>
  )
}

// Where the collapsed sidebar's toggle sits at the start of the content area. Windows keeps its titlebar in vertical
// tabs mode, so the toggle lives there instead.
function useCollapsedSlot() {
  const platform = usePlatform()
  const settings = useSettings()
  const sidebar = useSidebar()
  const desktop = createMediaQuery("(min-width: 768px)")
  const windows = () => platform.platform === "desktop" && platform.os === "windows"
  const mac = () => platform.platform === "desktop" && platform.os === "macos" && !platform.windowFullscreen?.()

  return {
    visible: () => desktop() && !windows() && sidebar.toggleable() && settings.appearance.tabLayout() === "vertical",
    open: sidebar.open,
    // Lay the toggle out as if the traffic lights were the header's first control, so it starts where the horizontal
    // titlebar's first control does.
    width: () => {
      const start = mac()
        ? macTrafficLightsBaseWidth / (platform.webviewZoom?.() ?? 1) + macTrafficLightsGap
        : contentStart
      return start - contentStart + slotWidth
    },
  }
}

const slotClass = "flex shrink-0 justify-end overflow-hidden"

// Floats over the top of every screen, centered on the session header's 48px row. Appears at the content's start edge
// when the sidebar closes.
export function CollapsedSidebarToggle() {
  const slot = useCollapsedSlot()

  return (
    <Show when={slot.visible()}>
      <div
        class={`absolute top-[calc(var(--shell-top-inset,8px)+10px)] start-[calc(var(--shell-inline-inset,8px)+10px)] z-40 ${slotClass}`}
        style={{ width: slot.open() ? "0px" : `${slot.width()}px` }}
        inert={slot.open()}
      >
        <div class="flex shrink-0 pe-1">
          <SidebarToggle />
        </div>
      </div>
    </Show>
  )
}

// Reserves the floating toggle's room in a header, pushing its contents along while the toggle is shown. `start` is where
// the space begins, in pixels from the content area's start edge, so every header's contents line up after the toggle.
export function CollapsedSidebarToggleSpace(props: { start?: number; class?: string }) {
  const slot = useCollapsedSlot()

  return (
    <Show when={slot.visible()}>
      <div
        aria-hidden="true"
        class={`${slotClass} ${props.class ?? ""}`}
        style={{ width: slot.open() ? "0px" : `${slot.width() + contentStart - (props.start ?? contentStart)}px` }}
      />
    </Show>
  )
}
