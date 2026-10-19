import { Component, Show } from "solid-js"
import { Switch } from "@opencode/ui/switch"
import { useLanguage } from "@/runtime/i18n/language"
import { SettingsList } from "@/settings/list"
import { useSettings } from "@/settings/model"
import { SettingsRow } from "@/settings/row"
import "@/settings/settings.css"
import { betaSettingsAvailable } from "./beta"

export const experimentalSettingsAvailable = true

export const SettingsExperimental: Component = () => {
  const language = useLanguage()
  const settings = useSettings()

  return (
    <>
      <div class="settings-tab-header">
        <div class="settings-tab-header-row">
          <div class="flex flex-col gap-1">
            <h2 class="settings-tab-title">{language.t("settings.tab.experimental")}</h2>
            <span class="text-11-regular text-v2-text-text-muted">
              {language.t("settings.experimental.description")}
            </span>
          </div>
        </div>
      </div>

      <div class="settings-tab-body">
        <div class="settings-section">
          <SettingsList>
            <SettingsRow
              title={language.t("settings.experimental.row.generatedUI.title")}
              description={language.t("settings.experimental.row.generatedUI.description")}
            >
              <div data-action="settings-generated-ui">
                <Switch
                  checked={settings.general.generatedUI()}
                  onChange={(checked) => settings.general.setGeneratedUI(checked)}
                />
              </div>
            </SettingsRow>
            <Show when={betaSettingsAvailable}>
              <SettingsRow
                title={language.t("settings.experimental.row.sidebarToggle.title")}
                description={language.t("settings.experimental.row.sidebarToggle.description")}
              >
                <div data-action="settings-sidebar-toggle">
                  <Switch
                    checked={settings.appearance.sidebarToggle()}
                    onChange={(checked) => settings.appearance.setSidebarToggle(checked)}
                  />
                </div>
              </SettingsRow>
            </Show>
          </SettingsList>
        </div>
      </div>
    </>
  )
}
